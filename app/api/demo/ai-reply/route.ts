import { NextRequest } from "next/server";
import {
  detectAndTranslate,
  generateReplySuggestion,
  pickReplyTranslation,
  type ReplyTranslationSettings,
} from "@/lib/classify";
import { getApp, getDefaultApp } from "@/lib/reviews";

export async function POST(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json(
      { error: "DEEPSEEK_API_KEY 未配置，无法生成 AI 回复建议" },
      { status: 503 }
    );
  }

  const { content, rating, tags, author, appId, replyContext, translateSettings } = await request.json();
  const app = appId ? await getApp(appId) : await getDefaultApp();

  try {
    const reply = await generateReplySuggestion({
      content,
      rating,
      author,
      tags: tags ?? [],
      appContext: app.context,
      replyContext: replyContext ?? null,
    });

    let translation: string | null = null;
    const ts = translateSettings as ReplyTranslationSettings | undefined;
    if (ts?.enabled) {
      const result = await detectAndTranslate(reply);
      translation = pickReplyTranslation(result, ts);
    }

    return Response.json({ reply, translation });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
