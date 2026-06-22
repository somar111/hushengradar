import { getServiceSupabase, type ReviewRow, type AppRow } from "./supabase";

// apps 表几乎不变（只有手动加新 App 时才变），缓存住省掉每次切筛选都白付一次 Supabase round trip
const APPS_CACHE_TTL_MS = 5 * 60 * 1000;
let appsCache: { apps: AppRow[]; fetchedAt: number } | null = null;

async function getCachedApps(): Promise<AppRow[]> {
  if (appsCache && Date.now() - appsCache.fetchedAt < APPS_CACHE_TTL_MS) return appsCache.apps;
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.from("apps").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  appsCache = { apps: data ?? [], fetchedAt: Date.now() };
  return appsCache.apps;
}

export async function listApps(): Promise<AppRow[]> {
  return getCachedApps();
}

export async function getDefaultApp(): Promise<AppRow> {
  const apps = await getCachedApps();
  if (!apps[0]) throw new Error("没有任何 App，先在 apps 表里插入一条");
  return apps[0];
}

export async function getApp(appId: string): Promise<AppRow> {
  const apps = await getCachedApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) throw new Error(`找不到 app: ${appId}`);
  return app;
}

export async function queryReviews(opts: {
  appId: string;
  tag?: string;
  locale?: string;
  rating?: number;
  q?: string;
  since?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: ReviewRow[]; total: number }> {
  const supabase = getServiceSupabase();
  let query = supabase
    .from("reviews")
    .select("*", { count: "exact" })
    .eq("app_id", opts.appId);

  if (opts.tag) query = query.contains("ai_tag_keys", [opts.tag]);
  if (opts.locale) query = query.eq("locale", opts.locale);
  if (opts.rating) query = query.eq("rating", opts.rating);
  if (opts.q) {
    // 去掉逗号/括号：PostgREST 的 .or() 语法里这两个字符是分隔符/分组符，搜索词里混进来会被当成额外筛选条件解析
    const safeQ = opts.q.replace(/[,()]/g, "");
    if (safeQ) {
      query = query.or(
        `content.ilike.%${safeQ}%,author.ilike.%${safeQ}%,translated_zh.ilike.%${safeQ}%,translated_en.ilike.%${safeQ}%`
      );
    }
  }
  if (opts.since) query = query.gte("review_date", opts.since);

  const from = (opts.page - 1) * opts.pageSize;
  const { data, error, count } = await query
    .order("review_date", { ascending: false })
    .range(from, from + opts.pageSize - 1);

  if (error) throw error;
  return { items: data ?? [], total: count ?? 0 };
}

// Supabase/PostgREST 单次查询默认最多返回 1000 行，不分页会悄悄截断（这个项目已经在
// cron-fetch.mjs 里踩过一次这个坑，这里是同一类查询的另一处，必须统一走这个分页 helper）。
type SupabaseQuery<T> = { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> };
async function fetchAllRows<T>(query: SupabaseQuery<T>, pageSize = 1000): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

type StatsFields = Pick<ReviewRow, "rating" | "locale" | "ai_tags" | "app_version" | "official_reply" | "review_date">;

// cron 每天才跑一次抓取，统计用的全量行短期内不会变，缓存住避免每次点筛选按钮都把全表拉一遍重新聚合
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
const statsRowsCache = new Map<string, { rows: StatsFields[]; summaryMap: Record<string, string>; fetchedAt: number }>();

async function getStatsRows(appId: string) {
  const cached = statsRowsCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) return cached;

  const supabase = getServiceSupabase();
  const rows = await fetchAllRows<StatsFields>(
    supabase.from("reviews").select("rating, locale, ai_tags, app_version, official_reply, review_date").eq("app_id", appId)
  );

  const { data: summaryRows, error: summaryErr } = await supabase
    .from("tag_summaries")
    .select("tag_key, summary")
    .eq("app_id", appId);
  if (summaryErr) throw summaryErr;
  const summaryMap: Record<string, string> = {};
  for (const s of summaryRows ?? []) summaryMap[s.tag_key] = s.summary;

  const entry = { rows, summaryMap, fetchedAt: Date.now() };
  statsRowsCache.set(appId, entry);
  return entry;
}

export async function computeStats(appId: string, locale?: string, since?: string) {
  const { rows: allRows, summaryMap } = await getStatsRows(appId);

  // localeCounts 现在跟 total 用同一份 since 过滤，侧边栏批次条数才能和"全部"对得上
  const sinceRows = since ? allRows.filter((r) => r.review_date >= since) : allRows;
  const localeCounts: Record<string, number> = {};
  for (const r of sinceRows) {
    const l = r.locale ?? "unknown";
    localeCounts[l] = (localeCounts[l] || 0) + 1;
  }

  const scoped = locale ? sinceRows.filter((r) => (r.locale ?? "unknown") === locale) : sinceRows;
  const total = scoped.length;
  const ratingDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tagCounts: Record<string, { label: string; count: number; summary: string | null }> = {};
  const versionMap = new Map<string, { count: number; ratingSum: number; dateSum: number }>();
  const dailyMap = new Map<string, { count: number; ratingSum: number }>();
  let withOfficialReply = 0;

  for (const r of scoped) {
    if (r.rating) ratingDist[r.rating]++;
    if (r.official_reply) withOfficialReply++;
    const day = r.review_date.slice(0, 10);
    const d = dailyMap.get(day) ?? { count: 0, ratingSum: 0 };
    d.count++;
    d.ratingSum += r.rating ?? 0;
    dailyMap.set(day, d);
    for (const t of r.ai_tags ?? []) {
      const entry = tagCounts[t.key] ?? { label: t.label, count: 0, summary: summaryMap[t.key] ?? null };
      entry.count++;
      tagCounts[t.key] = entry;
    }
    if (r.app_version) {
      const v = versionMap.get(r.app_version) ?? { count: 0, ratingSum: 0, dateSum: 0 };
      v.count++;
      v.ratingSum += r.rating ?? 0;
      v.dateSum += new Date(r.review_date).getTime();
      versionMap.set(r.app_version, v);
    }
  }

  // 版本号字符串本身不一定能按时间排序（不同App的版本号规则不一样，有的甚至换过编号体系），
  // 用该版本评论的平均时间近似它的真实时间顺序，比直接按版本号字符串/数值排靠谱
  const versionStats = [...versionMap.entries()]
    .map(([version, { count, ratingSum, dateSum }]) => ({
      version,
      count,
      avgRating: Math.round((ratingSum / count) * 100) / 100,
      avgDate: dateSum / count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
    .sort((a, b) => a.avgDate - b.avgDate);

  const dates = scoped.map((r) => r.review_date).filter(Boolean).sort();

  const dailyRatings = [...dailyMap.entries()]
    .map(([date, { count, ratingSum }]) => ({ date, avgRating: Math.round((ratingSum / count) * 100) / 100, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    total,
    dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    ratingDist,
    tagCounts,
    dailyRatings,
    localeCounts,
    versionStats,
    officialReplyRate: total ? Math.round((withOfficialReply / total) * 1000) / 10 : 0,
  };
}
