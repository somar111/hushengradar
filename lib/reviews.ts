import { getServiceSupabase, type ReviewRow, type AppRow } from "./supabase";

export async function listApps(): Promise<AppRow[]> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.from("apps").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getDefaultApp(): Promise<AppRow> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase
    .from("apps")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

export async function getApp(appId: string): Promise<AppRow> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.from("apps").select("*").eq("id", appId).single();
  if (error) throw error;
  return data;
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
  if (opts.q) query = query.or(`content.ilike.%${opts.q}%,author.ilike.%${opts.q}%`);
  if (opts.since) query = query.gte("review_date", opts.since);

  const from = (opts.page - 1) * opts.pageSize;
  const { data, error, count } = await query
    .order("review_date", { ascending: false })
    .range(from, from + opts.pageSize - 1);

  if (error) throw error;
  return { items: data ?? [], total: count ?? 0 };
}

// 拉全量字段做统计用，超过单次 1000 条上限就分页拉完（按当前体量够用，不做过度设计）
async function fetchAllForStats(appId: string, locale?: string, since?: string) {
  const supabase = getServiceSupabase();
  const all: ReviewRow[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let query = supabase
      .from("reviews")
      .select("rating, locale, ai_tags, app_version, official_reply, review_date")
      .eq("app_id", appId);
    if (locale) query = query.eq("locale", locale);
    if (since) query = query.gte("review_date", since);
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...((data ?? []) as ReviewRow[]));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export async function computeStats(appId: string, locale?: string, since?: string) {
  const supabase = getServiceSupabase();

  // localeCounts 始终基于该 App 全量计算（不受 since 影响），方便侧边栏任何时候都能显示各批次真实条数
  const { data: localeRows, error: localeErr } = await supabase
    .from("reviews")
    .select("locale")
    .eq("app_id", appId);
  if (localeErr) throw localeErr;
  const localeCounts: Record<string, number> = {};
  for (const r of localeRows ?? []) {
    const l = (r as { locale: string | null }).locale ?? "unknown";
    localeCounts[l] = (localeCounts[l] || 0) + 1;
  }

  // 摘要是按全量样本生成的，不分 locale/时间范围（避免每种筛选组合都单独算一份摘要），筛了照样复用同一份
  const { data: summaryRows, error: summaryErr } = await supabase
    .from("tag_summaries")
    .select("tag_key, summary")
    .eq("app_id", appId);
  if (summaryErr) throw summaryErr;
  const summaryMap: Record<string, string> = {};
  for (const s of summaryRows ?? []) summaryMap[s.tag_key] = s.summary;

  const scoped = await fetchAllForStats(appId, locale, since);
  const total = scoped.length;
  const ratingDist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tagCounts: Record<string, { label: string; count: number; summary: string | null }> = {};
  const versionMap = new Map<string, { count: number; ratingSum: number }>();
  let withOfficialReply = 0;

  for (const r of scoped) {
    if (r.rating) ratingDist[r.rating]++;
    if (r.official_reply) withOfficialReply++;
    for (const t of r.ai_tags ?? []) {
      const entry = tagCounts[t.key] ?? { label: t.label, count: 0, summary: summaryMap[t.key] ?? null };
      entry.count++;
      tagCounts[t.key] = entry;
    }
    if (r.app_version) {
      const v = versionMap.get(r.app_version) ?? { count: 0, ratingSum: 0 };
      v.count++;
      v.ratingSum += r.rating ?? 0;
      versionMap.set(r.app_version, v);
    }
  }

  const versionStats = [...versionMap.entries()]
    .map(([version, { count, ratingSum }]) => ({
      version,
      count,
      avgRating: Math.round((ratingSum / count) * 100) / 100,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const dates = scoped.map((r) => r.review_date).filter(Boolean).sort();

  return {
    total,
    dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
    ratingDist,
    tagCounts,
    localeCounts,
    versionStats,
    officialReplyRate: total ? Math.round((withOfficialReply / total) * 1000) / 10 : 0,
  };
}
