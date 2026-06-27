import { NextRequest } from "next/server";
import { getApp, getDefaultApp, computeStats } from "@/lib/reviews";

const STATS_EDGE_CACHE_SEC = 5 * 60;

/** Cloudflare Workers 的 Cache API；Node/Next 类型里没有 `caches.default`。 */
function edgeCache(): Cache | null {
  if (typeof caches === "undefined") return null;
  return (caches as unknown as { default: Cache }).default ?? null;
}

function cacheKeyFromUrl(url: string) {
  return new Request(url, { method: "GET" });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const forceRefresh = params.get("fresh") === "1";
  const cache = edgeCache();
  const cacheKey = cacheKeyFromUrl(request.url);

  if (cache && !forceRefresh) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (e) {
      console.warn("[api/demo/stats] cache read failed:", e);
    }
  }

  try {
    const appId = params.get("appId") || undefined;
    const locale = params.get("locale") || undefined;
    const since = params.get("since") || undefined;
    const app = appId ? await getApp(appId) : await getDefaultApp();
    // 首屏 stats 跳过 scoped LLM 摘要（数十个并行 DeepSeek 调用在 Workers 上易超时）；子标签 chip 不受影响。
    const stats = await computeStats(app.id, locale, since, undefined, {
      forceRefresh,
      appContext: app.context,
      attachDisplaySummaries: false,
    });
    const response = Response.json({ ...stats, app: { id: app.id, displayName: app.display_name } });
    if (cache && !forceRefresh) {
      try {
        response.headers.set(
          "Cache-Control",
          `public, s-maxage=${STATS_EDGE_CACHE_SEC}, stale-while-revalidate=${STATS_EDGE_CACHE_SEC * 2}`,
        );
        await cache.put(cacheKey, response.clone());
      } catch (e) {
        console.warn("[api/demo/stats] cache write failed:", e);
      }
    }
    return response;
  } catch (e) {
    console.error("[api/demo/stats]", e);
    return Response.json({ error: (e as Error).message || "统计计算失败" }, { status: 500 });
  }
}
