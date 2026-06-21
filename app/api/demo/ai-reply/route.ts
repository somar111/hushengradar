import { NextRequest } from "next/server";
import { generateReplySuggestion } from "@/lib/classify";
import { getDefaultApp } from "@/lib/reviews";

export async function POST(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json(
      { error: "DEEPSEEK_API_KEY 未配置，无法生成 AI 回复建议" },
      { status: 503 }
    );
  }

  const { content, rating, tags, author } = await request.json();
  const app = await getDefaultApp();

  try {
    const reply = await generateReplySuggestion({
      content,
      rating,
      author,
      tags: tags ?? [],
      appContext: app.context,
    });
    return Response.json({ reply });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
