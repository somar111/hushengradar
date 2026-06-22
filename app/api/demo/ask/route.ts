import { NextRequest } from "next/server";
import { getApp, getDefaultApp, computeStats, buildAnalysisMetrics } from "@/lib/reviews";
import { answerQuestion } from "@/lib/classify";

export async function POST(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY 未配置，无法回答" }, { status: 503 });
  }

  const { question, appId, locale, since, timeRangeLabel } = await request.json();
  if (!question || !String(question).trim()) {
    return Response.json({ error: "问题不能为空" }, { status: 400 });
  }

  const app = appId ? await getApp(appId) : await getDefaultApp();
  const stats = await computeStats(app.id, locale, since);
  const metrics = buildAnalysisMetrics(stats);

  try {
    const answer = await answerQuestion({
      question: String(question),
      appContext: app.context,
      timeRangeLabel: timeRangeLabel || "所选时间范围",
      metrics,
    });
    return Response.json({ answer });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
