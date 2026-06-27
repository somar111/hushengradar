import { getServiceSupabase, type ReviewRow, type AppRow, type TerminologyEntry } from "./supabase";
import { meaningfulLocaleFloor } from "./analysisShared";
import { mergeSimilarSubTags, sanitizeTerminologyGlossary, hasSubTagBreakdown } from "./promptKit.mjs";
import { hasActiveStatsScope, resolveGlobalTagDisplaySummary } from "./tagDisplaySummary.mjs";
import { invalidateScopedSummaryCache, invalidateScopedReviewSummaryCache, summarizeTagsForScope } from "./tagSummaries.mjs";
import { fetchStatsBundle } from "./reviewStatsRpc";
import { resolveDefaultDemoApp } from "./demoDefaults";

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

export function invalidateAppsCache() {
  appsCache = null;
}

export async function updateAppTerminologyGlossary(appId: string, glossary: TerminologyEntry[]): Promise<TerminologyEntry[]> {
  const cleaned = sanitizeTerminologyGlossary(glossary) as TerminologyEntry[];
  const supabase = getServiceSupabase();
  const { error } = await supabase.from("apps").update({ terminology_glossary: cleaned }).eq("id", appId);
  if (error) throw error;
  invalidateAppsCache();
  return cleaned;
}

export async function listApps(): Promise<AppRow[]> {
  return getCachedApps();
}

export async function getDefaultApp(): Promise<AppRow> {
  const apps = await getCachedApps();
  const app = resolveDefaultDemoApp(apps);
  if (!app) throw new Error("没有任何 App，先在 apps 表里插入一条");
  return app;
}

export async function getApp(appId: string): Promise<AppRow> {
  const apps = await getCachedApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) throw new Error(`找不到 app: ${appId}`);
  return app;
}

// "最近一月/一周"这类时间窗口的锚点——必须用这个App真实数据里最新的评论日期，不能用
// 服务器当前时间（Date.now()）。Google Play 的评论接口本身有1~2天的索引延迟（已经在
// 别处验证过），如果锚点定在"现在"，窗口尾部永远空在那里，看起来像是少了最近几天的数据，
// 其实是数据源还没把那几天的评论吐出来。锚定到"这个App实际最新一条评论的日期"，才能让
// "最近一月"真的对应这个App已有的最近30天数据，不同App/不同抓取延迟下都一样适用。
export async function getLatestReviewDate(appId: string): Promise<string | null> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("reviews")
    .select("review_date")
    .eq("app_id", appId)
    .order("review_date", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.review_date ?? null;
}

export type ReviewQueryFilters = {
  appId: string;
  tag?: string;
  subTag?: string;
  locale?: string;
  rating?: number;
  q?: string;
  since?: string;
  until?: string;
  replied?: boolean;
};

/** 评论回复栏「重跑筛选结果」单次上限 */
export const RECLASSIFY_MAX = 200;

export class ReclassifyLimitError extends Error {
  readonly total: number;

  constructor(total: number) {
    super(`当前筛选共 ${total} 条，超过单次上限 ${RECLASSIFY_MAX} 条，请缩小筛选范围`);
    this.name = "ReclassifyLimitError";
    this.total = total;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyReviewFilters(query: any, opts: Omit<ReviewQueryFilters, "appId">) {
  if (opts.tag && opts.subTag) query = query.contains("ai_tags", JSON.stringify([{ key: opts.tag, subKey: opts.subTag }]));
  else if (opts.tag) query = query.contains("ai_tags", JSON.stringify([{ key: opts.tag }]));
  if (opts.locale) query = query.eq("locale", opts.locale);
  if (opts.rating) query = query.eq("rating", opts.rating);
  if (opts.replied === true) query = query.not("official_reply", "is", null);
  if (opts.replied === false) query = query.is("official_reply", null);
  if (opts.q) {
    const safeQ = opts.q.replace(/[,()]/g, "");
    if (safeQ) {
      query = query.or(
        `content.ilike.%${safeQ}%,author.ilike.%${safeQ}%,translated_zh.ilike.%${safeQ}%,translated_en.ilike.%${safeQ}%`
      );
    }
  }
  if (opts.since) query = query.gte("review_date", opts.since);
  if (opts.until) query = query.lte("review_date", opts.until);
  return query;
}

/** 与评论查看&回复列表、`query_reviews` 同一套 applyReviewFilters 计数。 */
export async function countReviewsMatching(opts: ReviewQueryFilters): Promise<number> {
  const supabase = getServiceSupabase();
  const { appId, ...filters } = opts;
  let query = supabase.from("reviews").select("*", { count: "exact", head: true }).eq("app_id", appId);
  query = applyReviewFilters(query, filters);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

/** 在当前筛选条件下（不含 replied 筛选）统计全部/已回复/未回复数量，供评论回复栏下拉与计数展示。 */
export async function countReviewsReplyBreakdown(
  opts: Omit<ReviewQueryFilters, "replied">
): Promise<{ total: number; replied: number; unreplied: number }> {
  const [total, replied] = await Promise.all([
    countReviewsMatching(opts),
    countReviewsMatching({ ...opts, replied: true }),
  ]);
  return { total, replied, unreplied: Math.max(0, total - replied) };
}

/** 拉取当前筛选下待重跑的评论（须已选 tag；总量不得超过 RECLASSIFY_MAX） */
export async function fetchReviewsForReclassify(
  opts: ReviewQueryFilters
): Promise<{ reviews: Pick<ReviewRow, "id" | "content" | "rating" | "ai_tags">[]; total: number }> {
  if (!opts.tag) throw new Error("必须选择问题类型");
  const total = await countReviewsMatching(opts);
  if (total > RECLASSIFY_MAX) throw new ReclassifyLimitError(total);
  if (total === 0) return { reviews: [], total: 0 };

  const supabase = getServiceSupabase();
  const { appId, ...filters } = opts;
  let query = supabase.from("reviews").select("id, content, rating, ai_tags").eq("app_id", appId);
  query = applyReviewFilters(query, filters);
  const { data, error } = await query.order("review_date", { ascending: false }).limit(RECLASSIFY_MAX);
  if (error) throw error;
  return { reviews: data ?? [], total };
}

export function invalidateStatsCache(appId?: string) {
  if (appId) {
    for (const key of [...statsResultCache.keys()]) {
      if (key.startsWith(`${appId}\0`)) statsResultCache.delete(key);
    }
    invalidateScopedSummaryCache(appId);
    invalidateScopedReviewSummaryCache(appId);
  } else {
    statsResultCache.clear();
    invalidateScopedSummaryCache();
    invalidateScopedReviewSummaryCache();
  }
}

export type ReviewEvidenceItem = {
  id: string;
  rating: number | null;
  review_date: string;
  locale: string | null;
  evidence: string;
};

/** Ask summarize_reviews：单次主题归纳最多读取的评论条数（超出均匀抽样，计数仍用 count_reviews）。 */
export const ASK_SUMMARIZE_MAX = 1600;

function evidenceForTag(
  row: Pick<ReviewRow, "id" | "content" | "rating" | "review_date" | "locale" | "ai_tags">,
  tag?: string,
  subTag?: string
): string | null {
  const tags = row.ai_tags ?? [];
  let matched: (typeof tags)[number] | undefined;
  if (tag && subTag) matched = tags.find((t) => t.key === tag && t.subKey === subTag);
  else if (tag) matched = tags.find((t) => t.key === tag);
  const text = String(matched?.evidence ?? "").trim() || String(row.content ?? "").trim();
  return text || null;
}

type EvidenceRow = Pick<ReviewRow, "id" | "rating" | "review_date" | "locale" | "content" | "ai_tags">;

function rowsToEvidenceItems(
  rows: EvidenceRow[],
  tag?: string,
  subTag?: string
): { items: ReviewEvidenceItem[]; noTextInBatch: number } {
  const items: ReviewEvidenceItem[] = [];
  for (const row of rows) {
    const evidence = evidenceForTag(row, tag, subTag);
    if (!evidence) continue;
    items.push({
      id: row.id,
      rating: row.rating,
      review_date: row.review_date,
      locale: row.locale,
      evidence,
    });
  }
  return { items, noTextInBatch: rows.length - items.length };
}

export async function fetchReviewEvidenceForScope(
  opts: ReviewQueryFilters
): Promise<{
  items: ReviewEvidenceItem[];
  total: number;
  truncated: boolean;
  /** 实际拉取到的行数（≤ ASK_SUMMARIZE_MAX，或全量） */
  scanned: number;
  /** 已拉取行中无正文/evidence 的条数 */
  noTextInBatch: number;
}> {
  const total = await countReviewsMatching(opts);
  if (total === 0) return { items: [], total: 0, truncated: false, scanned: 0, noTextInBatch: 0 };

  const { appId, tag, subTag, ...filters } = opts;
  const truncated = total > ASK_SUMMARIZE_MAX;
  const supabase = getServiceSupabase();
  let query = supabase
    .from("reviews")
    .select("id, rating, review_date, locale, content, ai_tags")
    .eq("app_id", appId);
  query = applyReviewFilters(query, { tag, subTag, ...filters });

  // 只在 DB 侧拉取归纳所需行数（≤1600），避免大 scope 下全表分页耗尽 Worker subrequest 配额。
  const fetchLimit = truncated ? ASK_SUMMARIZE_MAX : total;
  const orderedQuery = query.order("review_date", { ascending: false }) as SupabaseQuery<EvidenceRow>;
  const rows = await fetchRowsUpTo(orderedQuery, fetchLimit);

  const { items, noTextInBatch } = rowsToEvidenceItems(rows, tag, subTag);

  return {
    items,
    total,
    truncated,
    scanned: rows.length,
    noTextInBatch,
  };
}

export async function queryReviews(opts: ReviewQueryFilters & {
  page: number;
  pageSize: number;
}): Promise<{ items: ReviewRow[]; total: number }> {
  const supabase = getServiceSupabase();
  const { appId, page, pageSize, ...filters } = opts;
  let query = supabase
    .from("reviews")
    .select("*", { count: "exact" })
    .eq("app_id", appId);
  query = applyReviewFilters(query, filters);

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("review_date", { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) throw error;
  return { items: data ?? [], total: count ?? 0 };
}

// Supabase/PostgREST 单次查询默认最多返回 1000 行，不分页会悄悄截断（这个项目已经在
// cron-fetch.mjs 里踩过一次这个坑，这里是同一类查询的另一处，必须统一走这个分页 helper）。
type SupabaseQuery<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
  limit: (n: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};
/** 分页拉取至多 maxRows 行（Workers 上控制 subrequest 次数）。 */
async function fetchRowsUpTo<T>(query: SupabaseQuery<T>, maxRows: number, pageSize = 1000): Promise<T[]> {
  if (maxRows <= 0) return [];
  const all: T[] = [];
  let from = 0;
  while (all.length < maxRows) {
    const chunk = Math.min(pageSize, maxRows - all.length);
    const { data, error } = await query.range(from, from + chunk - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < chunk) break;
    from += chunk;
  }
  return all;
}

// 统计 RPC 结果短期缓存（同 isolate 内 Ask 多工具复用）
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;

export type ComputedStats = {
  total: number;
  windowReviewTotal: number;
  dateRange: { from: string | null; to: string | null };
  ratingDist: Record<number, number>;
  tagCounts: Record<
    string,
    {
      label: string;
      count: number;
      summary: string | null;
      repliedCount: number;
      subTags: Record<string, { label: string; count: number }>;
    }
  >;
  dailyRatings: { date: string; avgRating: number; count: number }[];
  localeCounts: Record<string, number>;
  localeRatings: { locale: string; count: number; avgRating: number }[];
  versionStats: { version: string; count: number; avgRating: number; avgDate: number }[];
  officialReplyRate: number;
};

const statsResultCache = new Map<string, { stats: ComputedStats; fetchedAt: number }>();

function statsResultCacheKey(appId: string, locale?: string, since?: string, until?: string) {
  return `${appId}\0${locale ?? ""}\0${since ?? ""}\0${until ?? ""}`;
}

async function loadTagSummaryMap(appId: string): Promise<Record<string, string>> {
  const supabase = getServiceSupabase();
  const { data: summaryRows, error } = await supabase
    .from("tag_summaries")
    .select("tag_key, summary")
    .eq("app_id", appId);
  if (error) throw error;
  const summaryMap: Record<string, string> = {};
  for (const s of summaryRows ?? []) summaryMap[s.tag_key] = s.summary;
  return summaryMap;
}

/** scope 内缺 chip 的顶层标签：限量拉 evidence 样本供离线摘要管线复用。 */
async function fetchTagEvidenceSamples(
  appId: string,
  tagKey: string,
  filters: { locale?: string; since?: string; until?: string },
  rowLimit = 80
): Promise<string[]> {
  const supabase = getServiceSupabase();
  let query = supabase
    .from("reviews")
    .select("content, ai_tags")
    .eq("app_id", appId)
    .contains("ai_tags", JSON.stringify([{ key: tagKey }]))
    .limit(rowLimit);
  if (filters.locale) query = query.eq("locale", filters.locale);
  if (filters.since) query = query.gte("review_date", filters.since);
  if (filters.until) query = query.lte("review_date", filters.until);
  const { data, error } = await query;
  if (error) throw error;
  const texts: string[] = [];
  for (const row of data ?? []) {
    const tags = (row.ai_tags ?? []) as { key?: string; evidence?: string }[];
    for (const t of tags) {
      if (t?.key !== tagKey) continue;
      const text = String(t.evidence ?? "").trim() || String(row.content ?? "").trim();
      if (text) {
        texts.push(text);
        break;
      }
    }
  }
  return texts;
}

export async function computeStats(
  appId: string,
  locale?: string,
  since?: string,
  until?: string,
  opts: {
    forceRefresh?: boolean;
    appContext?: string | null;
    attachDisplaySummaries?: boolean;
    apiKey?: string | null;
  } = {},
): Promise<ComputedStats> {
  const cacheKey = statsResultCacheKey(appId, locale, since, until);
  if (opts.forceRefresh) statsResultCache.delete(cacheKey);
  const cached = statsResultCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
    return cached.stats;
  }

  const [bundle, summaryMap] = await Promise.all([
    fetchStatsBundle(appId, locale, since, until),
    loadTagSummaryMap(appId),
  ]);

  const scopeActive = hasActiveStatsScope({ locale, since, until });
  const tagCounts: Record<
    string,
    { label: string; count: number; summary: string | null; repliedCount: number; subTags: Record<string, { label: string; count: number }> }
  > = {};

  const tagsNeedingScopedSummary: {
    key: string;
    label: string;
    contents: string[];
    subTags: Record<string, { label: string; count: number }>;
  }[] = [];

  for (const [key, entry] of Object.entries(bundle.tagCounts)) {
    const subTags = mergeSimilarSubTags(entry.subTags);
    const tagEntry = {
      label: entry.label || key,
      count: entry.count,
      repliedCount: entry.repliedCount,
      summary: null as string | null,
      subTags,
    };
    if (scopeActive) {
      if (!hasSubTagBreakdown(subTags)) {
        tagsNeedingScopedSummary.push({ key, label: tagEntry.label, contents: [], subTags });
      }
    } else {
      tagEntry.summary = resolveGlobalTagDisplaySummary({
        globalSummary: summaryMap[key] ?? null,
        subTags,
      });
    }
    tagCounts[key] = tagEntry;
  }

  const attachDisplaySummaries = opts.attachDisplaySummaries !== false;
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null;
  if (scopeActive && attachDisplaySummaries && tagsNeedingScopedSummary.length && apiKey) {
    await Promise.all(
      tagsNeedingScopedSummary.map(async (t) => {
        t.contents = await fetchTagEvidenceSamples(appId, t.key, { locale, since, until });
      })
    );
    const scopedSummaries = await summarizeTagsForScope({
      appId,
      apiKey,
      appContext: opts.appContext ?? undefined,
      locale,
      since,
      until,
      tags: tagsNeedingScopedSummary,
    });
    for (const [key, summary] of Object.entries(scopedSummaries)) {
      if (tagCounts[key]) tagCounts[key].summary = summary;
    }
  }

  const stats: ComputedStats = {
    total: bundle.total,
    windowReviewTotal: bundle.windowReviewTotal,
    dateRange: bundle.dateRange,
    ratingDist: bundle.ratingDist,
    tagCounts,
    dailyRatings: bundle.dailyRatings,
    localeCounts: bundle.localeCounts,
    localeRatings: bundle.localeRatings,
    versionStats: bundle.versionStats,
    officialReplyRate: bundle.officialReplyRate,
  };

  statsResultCache.set(cacheKey, { stats, fetchedAt: Date.now() });
  return stats;
}

/**
 * 把 computeStats 的结果整理成喂给AI（/api/demo/insights 和 /api/demo/ask 共用）的真实数字。
 * 单一来源，避免两条AI调用各自拼一份、改一处漏改另一处。
 */
export function buildAnalysisMetrics(stats: ComputedStats) {
  const localeFloor = meaningfulLocaleFloor(stats.total);
  const overallAvgRating = stats.total
    ? Math.round(
        (Object.entries(stats.ratingDist).reduce((sum, [k, v]) => sum + Number(k) * v, 0) / stats.total) * 100
      ) / 100
    : null;

  return {
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
      pctOfTotal: stats.total ? Math.round((t.count / stats.total) * 1000) / 10 : 0,
      replyRate: t.count ? Math.round((t.repliedCount / t.count) * 1000) / 10 : 0,
    })),
    overallReplyRate: stats.officialReplyRate,
    // 只把样本量够大的地区喂给AI，跟前端地区列表用同一个门槛，避免AI对被隐藏的小样本地区下结论
    localeRatings: stats.localeRatings
      .filter((l) => l.count >= localeFloor)
      .map((l) => ({ locale: l.locale, reviewCount: l.count, avgRating: l.avgRating })),
  };
}
