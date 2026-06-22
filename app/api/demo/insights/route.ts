import { NextRequest } from "next/server";
import { getApp, getDefaultApp, computeStats, buildAnalysisMetrics } from "@/lib/reviews";
import { generateInsights } from "@/lib/classify";

export async function GET(request: NextRequest) {
  if (!process.env.DEEPSEEK_API_KEY) {
    return Response.json({ error: "DEEPSEEK_API_KEY 未配置，无法生成分析结论" }, { status: 503 });
  }

  const params = request.nextUrl.searchParams;
  const appId = params.get("appId") || undefined;
  const locale = params.get("locale") || undefined;
  const since = params.get("since") || undefined;
  const timeRangeLabel = params.get("timeRangeLabel") || "所选时间范围";

  const app = appId ? await getApp(appId) : await getDefaultApp();
  const stats = await computeStats(app.id, locale, since);

  if (!stats.total) {
    return Response.json({
      versionTrend: null, ratingDistribution: null, complaintsVsFeatureRequest: null, replyGap: null, localeGap: null,
    });
  }

  const metrics = buildAnalysisMetrics(stats);

  try {
    const insights = await generateInsights({ timeRangeLabel, appContext: app.context, metrics });
    return Response.json(insights);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
