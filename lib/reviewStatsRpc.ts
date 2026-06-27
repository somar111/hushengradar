import { getServiceSupabase } from "./supabase";

export type LocaleStatsRow = {
  locale: string;
  reviewCount: number;
  avgRating: number;
};

type RpcTagEntry = {
  label: string;
  count: number;
  repliedCount: number;
  subTags: Record<string, { label: string; count: number }>;
};

export type RpcStatsBundle = {
  total: number;
  windowReviewTotal: number;
  dateRange: { from: string | null; to: string | null };
  ratingDist: Record<number, number>;
  dailyRatings: { date: string; avgRating: number; count: number }[];
  localeCounts: Record<string, number>;
  localeRatings: { locale: string; count: number; avgRating: number }[];
  versionStats: { version: string; count: number; avgRating: number; avgDate: number }[];
  officialReplyRate: number;
  tagCounts: Record<string, RpcTagEntry>;
};

function emptyRatingDist(): Record<number, number> {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function parseStatsBundle(raw: unknown): RpcStatsBundle {
  const o = (raw ?? {}) as Record<string, unknown>;
  const ratingDist = emptyRatingDist();
  const rawDist = (o.ratingDist ?? {}) as Record<string, number>;
  for (const k of ["1", "2", "3", "4", "5"]) {
    const n = Number(rawDist[k] ?? 0);
    if (n) ratingDist[Number(k) as 1 | 2 | 3 | 4 | 5] = n;
  }

  const dr = o.dateRange as { from?: string | null; to?: string | null } | undefined;

  return {
    total: Number(o.total ?? 0),
    windowReviewTotal: Number(o.windowReviewTotal ?? 0),
    dateRange: { from: dr?.from ?? null, to: dr?.to ?? null },
    ratingDist,
    dailyRatings: ((o.dailyRatings ?? []) as { date: string; avgRating: number; count: number }[]).map((d) => ({
      date: d.date,
      avgRating: Number(d.avgRating),
      count: Number(d.count),
    })),
    localeCounts: (o.localeCounts ?? {}) as Record<string, number>,
    localeRatings: ((o.localeRatings ?? []) as { locale: string; count: number; avgRating: number }[]).map((l) => ({
      locale: l.locale,
      count: Number(l.count),
      avgRating: Number(l.avgRating),
    })),
    versionStats: ((o.versionStats ?? []) as { version: string; count: number; avgRating: number; avgDate: number }[]).map(
      (v) => ({
        version: v.version,
        count: Number(v.count),
        avgRating: Number(v.avgRating),
        avgDate: Number(v.avgDate),
      })
    ),
    officialReplyRate: Number(o.officialReplyRate ?? 0),
    tagCounts: (o.tagCounts ?? {}) as Record<string, RpcTagEntry>,
  };
}

/** 地区分布：1 次 Supabase RPC。 */
export async function fetchLocaleStats(
  appId: string,
  since?: string,
  until?: string
): Promise<{ locales: LocaleStatsRow[]; dateRange: { from: string | null; to: string | null } }> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.rpc("review_stats_locales", {
    p_app_id: appId,
    p_since: since ?? null,
    p_until: until ?? null,
  });
  if (error) throw error;

  const o = (data ?? {}) as {
    dateRange?: { from?: string | null; to?: string | null };
    locales?: { locale: string; reviewCount: number; avgRating: number }[];
  };

  return {
    dateRange: { from: o.dateRange?.from ?? null, to: o.dateRange?.to ?? null },
    locales: (o.locales ?? []).map((row) => ({
      locale: row.locale,
      reviewCount: Number(row.reviewCount),
      avgRating: Number(row.avgRating),
    })),
  };
}

/** 全量 stats 聚合：1 次 RPC。 */
export async function fetchStatsBundle(
  appId: string,
  locale?: string,
  since?: string,
  until?: string
): Promise<RpcStatsBundle> {
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.rpc("review_stats_bundle", {
    p_app_id: appId,
    p_locale: locale ?? null,
    p_since: since ?? null,
    p_until: until ?? null,
  });
  if (error) throw error;
  return parseStatsBundle(data);
}
