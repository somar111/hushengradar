import { NextRequest } from "next/server";
import {
  generateReplySuggestion,
  replyTranslationNeeded,
  translateReplyForDeveloper,
  type ReplyTranslationSettings,
} from "@/lib/classify";
import { formatDeepSeekUserError } from "@/lib/deepseekFetch.mjs";
import {
  buildDeterministicPlaybookFallback,
  buildReplyGenerationHints,
  computeReplyPlaybookInputsHash,
  mergeReplySettings,
} from "@/lib/replyPlaybook.mjs";
import { getApp, getDefaultApp } from "@/lib/reviews";

export const maxDuration = 60;

function resolveReplyPlaybookForRequest(
  app: Awaited<ReturnType<typeof getApp>>,
  replySettings: ReturnType<typeof mergeReplySettings>
) {
  const hash = computeReplyPlaybookInputsHash({
    context: app.context,
    replySettings,
    terminologyGlossary: app.terminology_glossary,
    displayName: app.display_name,
  });
  if (app.reply_playbook && app.reply_playbook_inputs_hash === hash) {
    return app.reply_playbook;
  }
  // 热路径不跑 LLM 压缩；cron / 术语保存后离线刷新。此处用确定性短手册兜底。
  return buildDeterministicPlaybookFallback({
    displayName: app.display_name,
    context: app.context,
    replySettings,
    terminologyGlossary: app.terminology_glossary,
  });
}

export async function POST(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json(
      { error: "DEEPSEEK_API_KEY 未配置，无法生成 AI 回复建议" },
      { status: 503 }
    );
  }

  const body = await request.json();
  const app = body.appId ? await getApp(body.appId) : await getDefaultApp();
  const replySettings = mergeReplySettings(app.reply_settings);

  try {
    if (body.mode === "translate") {
      const ts = body.translateSettings as ReplyTranslationSettings | undefined;
      const reply = String(body.reply ?? "").trim();
      if (!reply) {
        return Response.json({ error: "缺少待翻译的回复正文" }, { status: 400 });
      }
      if (!ts?.enabled || !replyTranslationNeeded(body.reviewDetectedLang, ts)) {
        return Response.json({ translation: null });
      }
      const translation = await translateReplyForDeveloper(reply, ts.targetLang, {
        displayName: app.display_name,
        terminologyGlossary: app.terminology_glossary ?? [],
      });
      return Response.json({ translation: translation || null });
    }

    const { content, rating, tags, author } = body;
    const playbook = resolveReplyPlaybookForRequest(app, replySettings);
    const generationHints = buildReplyGenerationHints({
      rating,
      tags: tags ?? [],
      content,
      replySettings,
    });

    const { reply } = await generateReplySuggestion({
      content,
      rating,
      author,
      tags: tags ?? [],
      replyPlaybook: playbook,
      generationHints,
      contactCorpus: [content, replySettings.contactInfo].join("\n"),
    });

    return Response.json({ reply });
  } catch (e) {
    return Response.json({ error: formatDeepSeekUserError(e) }, { status: 502 });
  }
}
