import { NextRequest } from "next/server";
import { getApp, getDefaultApp, getLatestReviewDate } from "@/lib/reviews";
import { answerQuestionStream } from "@/lib/classify";
import { formatDeepSeekUserError } from "@/lib/deepseekFetch.mjs";

export async function POST(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY 未配置，无法回答" }, { status: 503 });
  }

  const { question, appId, locale, since, timeRangeLabel, history, useEmoji, useThinking, tag, subTag } =
    await request.json();
  if (!question || !String(question).trim()) {
    return Response.json({ error: "问题不能为空" }, { status: 400 });
  }

  // 历史问答只信任 { q, a } 字符串结构，逐项做类型与长度兜底，防止前端传脏数据撑爆上下文
  const safeHistory = Array.isArray(history)
    ? history
        .filter((h: unknown): h is { q: unknown; a: unknown } => Boolean(h) && typeof h === "object")
        .map((h: { q: unknown; a: unknown }) => ({
          q: typeof h.q === "string" ? h.q.slice(0, 2000) : "",
          a: typeof h.a === "string" ? h.a.slice(0, 4000) : "",
        }))
        .filter((h) => h.q && h.a)
        .slice(-8)
    : undefined;

  let app: Awaited<ReturnType<typeof getApp>>;
  let latestReviewDate: string | null;
  try {
    app = appId ? await getApp(appId) : await getDefaultApp();
    latestReviewDate = await getLatestReviewDate(app.id);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }

  // NDJSON 流：每行一个事件 {type:"delta"|"replace"|"done"|"error", ...}，答案 token 边生成边下发
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        for await (const event of answerQuestionStream({
          question: String(question),
          appId: app.id,
          appContext: app.context,
          displayName: app.display_name,
          terminologyGlossary: app.terminology_glossary ?? [],
          seedCategories: app.seed_categories ?? [],
          universalSubcategories:
            (app as { taxonomy_meta?: { universal_subcategories?: Record<string, { key: string; label: string }[]> } })
              .taxonomy_meta?.universal_subcategories ?? {},
          timeRangeLabel: timeRangeLabel || "所选时间范围",
          latestReviewDate,
          defaultSince: since || undefined,
          defaultLocale: locale || undefined,
          defaultTag: typeof tag === "string" && tag ? tag : undefined,
          defaultSubTag: typeof subTag === "string" && subTag ? subTag : undefined,
          history: safeHistory,
          useEmoji: useEmoji === true,
          useThinking: useThinking === true,
          signal: request.signal,
        })) {
          send(event);
        }
      } catch (e) {
        if ((e as Error)?.name === "AbortError") {
          // 客户端主动断开（点了"停止"），静默收尾即可
        } else {
          send({ type: "error", message: formatDeepSeekUserError(e) });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
