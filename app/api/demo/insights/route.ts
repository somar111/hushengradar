import { NextRequest } from "next/server";
import { getApp, getDefaultApp, computeStats } from "@/lib/reviews";
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

  const overallAvgRating =
    Math.round(
      (Object.entries(stats.ratingDist).reduce((sum, [k, v]) => sum + Number(k) * v, 0) / stats.total) * 100
    ) / 100;

  const metrics = {
    totalReviews: stats.total,
    ratingDistribution: stats.ratingDist,
    overallAvgRating,
    versionStats: stats.versionStats.map((v) => ({
      version: v.version,
      reviewCount: v.count,
      avgRating: v.avgRating,
      approxDate: new Date(v.avgDate).toISOString().slice(0, 10),
    })),
    tagBreakdown: Object.entries(stats.tagCounts).map(([key, t]) => ({
      key,
      label: t.label,
      count: t.count,
      pctOfTotal: Math.round((t.count / stats.total) * 1000) / 10,
      replyRate: t.count ? Math.round((t.repliedCount / t.count) * 1000) / 10 : 0,
    })),
    overallReplyRate: stats.officialReplyRate,
    localeRatings: stats.localeRatings.map((l) => ({
      locale: l.locale,
      reviewCount: l.count,
      avgRating: l.avgRating,
    })),
  };

  try {
    const insights = await generateInsights({ timeRangeLabel, appContext: app.context, metrics });
    return Response.json(insights);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
