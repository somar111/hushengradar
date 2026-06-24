import { NextRequest } from "next/server";
import { getApp, getDefaultApp, getLatestReviewDate } from "@/lib/reviews";
import { answerQuestion } from "@/lib/classify";

export async function POST(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY 未配置，无法回答" }, { status: 503 });
  }

  const { question, appId, locale, since, timeRangeLabel, history } = await request.json();
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

  const app = appId ? await getApp(appId) : await getDefaultApp();
  const latestReviewDate = await getLatestReviewDate(app.id);

  try {
    const answer = await answerQuestion({
      question: String(question),
      appId: app.id,
      appContext: app.context,
      timeRangeLabel: timeRangeLabel || "所选时间范围",
      latestReviewDate,
      defaultSince: since || undefined,
      defaultLocale: locale || undefined,
      history: safeHistory,
    });
    return Response.json({ answer });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
