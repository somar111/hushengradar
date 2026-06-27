import { getServiceSupabase, type ReviewRow, type AppRow, type TerminologyEntry } from "./supabase";
import { meaningfulLocaleFloor } from "./analysisShared";
import { mergeSimilarSubTags, sanitizeTerminologyGlossary, hasSubTagBreakdown, accumulateTagCountsFromReview } from "./promptKit.mjs";
import { hasActiveStatsScope, resolveGlobalTagDisplaySummary } from "./tagDisplaySummary.mjs";
import { invalidateScopedSummaryCache, invalidateScopedReviewSummaryCache, summarizeTagsForScope } from "./tagSummaries.mjs";
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
  else if (opts.tag) query = query.contains("ai_tag_keys", [opts.tag]);
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

type ListCountScope = Pick<ReviewQueryFilters, "appId" | "since" | "until" | "locale">;

/** 用与评论列表相同的 SQL 口径覆盖 tag 计数（真实评论条数，非内存 tag 命中累加）。 */
async function reconcileTagCountsFromListFilters(
  scope: ListCountScope,
  tagCounts: Record<
    string,
    { label: string; count: number; summary: string | null; repliedCount: number; subTags: Record<string, { label: string; count: number }> }
  >,
) {
  const { appId, since, until, locale } = scope;
  const base: ReviewQueryFilters = { appId, since, until, locale: locale || undefined };
  await Promise.all(
    Object.entries(tagCounts).map(async ([key, entry]) => {
      const [parentCount, repliedCount, subPairs] = await Promise.all([
        countReviewsMatching({ ...base, tag: key }),
        countReviewsMatching({ ...base, tag: key, replied: true }),
        Promise.all(
          Object.keys(entry.subTags).map(
            async (subKey) => [subKey, await countReviewsMatching({ ...base, tag: key, subTag: subKey })] as const,
          ),
        ),
      ]);
      entry.count = parentCount;
      entry.repliedCount = repliedCount;
      for (const [subKey, n] of subPairs) {
        if (entry.subTags[subKey]) entry.subTags[subKey].count = n;
      }
    }),
  );
}

/** 时间窗内各 locale / 全部 / 当前筛选下的评论条数，与列表 count 一致。 */
async function reconcileWindowAndLocaleCounts(
  scope: ListCountScope,
  localeKeys: string[],
): Promise<{ total: number; windowReviewTotal: number; localeCounts: Record<string, number> }> {
  const { appId, since, until, locale } = scope;
  const windowScope: ReviewQueryFilters = { appId, since, until };
  const [windowReviewTotal, total, localePairs] = await Promise.all([
    countReviewsMatching(windowScope),
    countReviewsMatching({ ...windowScope, locale: locale || undefined }),
    Promise.all(localeKeys.map(async (l) => [l, await countReviewsMatching({ ...windowScope, locale: l })] as const)),
  ]);
  return { total, windowReviewTotal, localeCounts: Object.fromEntries(localePairs) };
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
    statsRowsCache.delete(appId);
    invalidateScopedSummaryCache(appId);
    invalidateScopedReviewSummaryCache(appId);
  } else {
    statsRowsCache.clear();
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

/** 在按时间排序的全量索引上均匀取 cap 个下标（超出上限时抽样，覆盖整段时间）。 */
function stratifiedSampleIndices(total: number, cap: number): number[] {
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  if (cap <= 1) return [0];
  const indices: number[] = [];
  for (let i = 0; i < cap; i++) {
    indices.push(Math.round((i * (total - 1)) / (cap - 1)));
  }
  return indices;
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

  let rows: EvidenceRow[];
  if (!truncated) {
    const { data, error } = await query.order("review_date", { ascending: false }).limit(total);
    if (error) throw error;
    rows = data ?? [];
  } else {
    const allRows = await fetchAllRows<EvidenceRow>(
      query.order("review_date", { ascending: false }) as SupabaseQuery<EvidenceRow>
    );
    const picked = stratifiedSampleIndices(allRows.length, ASK_SUMMARIZE_MAX).map((i) => allRows[i]!);
    rows = picked;
  }

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

type StatsFields = Pick<
  ReviewRow,
  "rating" | "locale" | "ai_tags" | "ai_tag_keys" | "app_version" | "official_reply" | "review_date" | "content"
>;

// cron 每天才跑一次抓取，统计用的全量行短期内不会变，缓存住避免每次点筛选按钮都把全表拉一遍重新聚合
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
const statsRowsCache = new Map<string, { rows: StatsFields[]; summaryMap: Record<string, string>; fetchedAt: number }>();

async function getStatsRows(appId: string, { forceRefresh = false } = {}) {
  if (forceRefresh) statsRowsCache.delete(appId);
  const cached = statsRowsCache.get(appId);
  if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) return cached;

  const supabase = getServiceSupabase();
  const rows = await fetchAllRows<StatsFields>(
    supabase.from("reviews").select("rating, locale, ai_tags, ai_tag_keys, app_version, official_reply, review_date, content").eq("app_id", appId)
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
) {
  const { rows: allRows, summaryMap } = await getStatsRows(appId, { forceRefresh: opts.forceRefresh });

  // localeCounts/localeRatings 都跟 total 用同一份 since 过滤、但不受当前 locale 筛选影响——
  // 这俩是给"对比各地区"用的，如果跟着当前选中的单一 locale 一起过滤就没法对比了
  let sinceRows = since ? allRows.filter((r) => r.review_date >= since) : allRows;
  if (until) sinceRows = sinceRows.filter((r) => r.review_date <= until);
  const localeRatingMap = new Map<string, { count: number; ratingSum: number }>();
  const localeKeys = new Set<string>();
  for (const r of sinceRows) {
    const l = r.locale;
    if (l) localeKeys.add(l);
    if (!l) continue;
    const lr = localeRatingMap.get(l) ?? { count: 0, ratingSum: 0 };
    lr.count++;
    lr.ratingSum += r.rating ?? 0;
    localeRatingMap.set(l, lr);
  }

  const scoped = locale ? sinceRows.filter((r) => (r.locale ?? "unknown") === locale) : sinceRows;
  const scopeActive = hasActiveStatsScope({ locale, since, until });
  const listScope: ListCountScope = { appId, since, until, locale };
  const ratingDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tagCounts: Record<
    string,
    { label: string; count: number; summary: string | null; repliedCount: number; subTags: Record<string, { label: string; count: number }> }
  > = {};
  const tagSamples: Record<string, string[]> = {};
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
    accumulateTagCountsFromReview(r, tagCounts, { tagSamples, skipCounts: true });
    if (r.app_version) {
      const v = versionMap.get(r.app_version) ?? { count: 0, ratingSum: 0, dateSum: 0 };
      v.count++;
      v.ratingSum += r.rating ?? 0;
      v.dateSum += new Date(r.review_date).getTime();
      versionMap.set(r.app_version, v);
    }
  }

  const [{ total, windowReviewTotal, localeCounts }] = await Promise.all([
    reconcileWindowAndLocaleCounts(listScope, [...localeKeys]),
    reconcileTagCountsFromListFilters(listScope, tagCounts),
  ]);

  const tagsNeedingScopedSummary: {
    key: string;
    label: string;
    contents: string[];
    subTags: Record<string, { label: string; count: number }>;
  }[] = [];

  for (const [key, entry] of Object.entries(tagCounts)) {
    entry.subTags = mergeSimilarSubTags(entry.subTags);
    if (scopeActive) {
      if (!hasSubTagBreakdown(entry.subTags)) {
        tagsNeedingScopedSummary.push({
          key,
          label: entry.label,
          contents: tagSamples[key] ?? [],
          subTags: entry.subTags,
        });
      }
      entry.summary = null;
    } else {
      entry.summary = resolveGlobalTagDisplaySummary({
        globalSummary: summaryMap[key] ?? null,
        subTags: entry.subTags,
      });
    }
  }

  const attachDisplaySummaries = opts.attachDisplaySummaries !== false;
  const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null;
  if (scopeActive && attachDisplaySummaries && tagsNeedingScopedSummary.length && apiKey) {
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

  // 评分最低的地区排前面，方便一眼看出最不满意的市场在哪
  const localeRatings = [...localeRatingMap.entries()]
    .map(([loc, { count: memCount, ratingSum }]) => ({
      locale: loc,
      count: localeCounts[loc] ?? memCount,
      avgRating: memCount ? Math.round((ratingSum / memCount) * 100) / 100 : 0,
    }))
    .sort((a, b) => a.avgRating - b.avgRating);

  return {
    total,
    windowReviewTotal,
    dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    ratingDist,
    tagCounts,
    dailyRatings,
    localeCounts,
    localeRatings,
    versionStats,
    officialReplyRate: total ? Math.round((withOfficialReply / total) * 1000) / 10 : 0,
  };
}

/**
 * 把 computeStats 的结果整理成喂给AI（/api/demo/insights 和 /api/demo/ask 共用）的真实数字。
 * 单一来源，避免两条AI调用各自拼一份、改一处漏改另一处。
 */
export function buildAnalysisMetrics(stats: Awaited<ReturnType<typeof computeStats>>) {
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
