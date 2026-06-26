import {
  getCachedScopedReviewSummary,
  mapReduceSummarizeEvidence,
  sampleDiverse,
  setCachedScopedReviewSummary,
} from "./tagSummaries.mjs";
import { ASK_SUMMARIZE_MAX, fetchReviewEvidenceForScope, type ReviewQueryFilters } from "./reviews";

export type SummarizeReviewsTheme = { label: string; description: string };

export type SummarizeReviewsResult = {
  filters: Record<string, string | number | null>;
  scopeLabel: string;
  total: number;
  evidenceUsed: number;
  coveredAll: boolean;
  truncated: boolean;
  fromCache: boolean;
  llmCalls: number;
  themes: SummarizeReviewsTheme[];
  representativeQuotes: {
    reviewId: string;
    date: string;
    rating: number | null;
    locale: string | null;
    evidence: string;
  }[];
  note: string;
};

function resolveScopeLabel(
  seedCategories: { key: string; label: string; subcategories?: { key: string; label: string }[] }[] | null | undefined,
  tag?: string,
  subTag?: string
): string {
  if (!tag) {
    if (subTag) return subTag === "general" ? "其他" : subTag;
    return "当前筛选";
  }
  const cat = seedCategories?.find((c) => c.key === tag);
  if (!cat) return subTag ? `${tag} → ${subTag}` : tag;
  if (subTag) {
    const sub = cat.subcategories?.find((s) => s.key === subTag);
    const subLabel = sub?.label ?? (subTag === "general" ? "其他" : subTag);
    return `${cat.label} → ${subLabel}`;
  }
  return cat.label;
}

export async function summarizeReviewsForAsk(opts: {
  appId: string;
  appContext?: string | null;
  seedCategories?: { key: string; label: string; subcategories?: { key: string; label: string }[] }[] | null;
  filters: ReviewQueryFilters;
}): Promise<SummarizeReviewsResult> {
  const { appId, appContext, seedCategories, filters } = opts;
  const { tag, subTag, locale, since, until, rating, q } = filters;

  const scopeLabel = resolveScopeLabel(seedCategories, tag, subTag);
  const filterRecord = {
    since: since ?? null,
    until: until ?? null,
    locale: locale ?? null,
    tag: tag ?? null,
    subTag: subTag ?? null,
    rating: rating ?? null,
    q: q ?? null,
  };

  const cached = getCachedScopedReviewSummary(appId, locale, since, until, tag, subTag, q, rating);
  if (cached.payload) {
    return cached.payload as SummarizeReviewsResult;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY 未配置");

  const { items, total, truncated } = await fetchReviewEvidenceForScope(filters);
  const evidences = items.map((i) => i.evidence);

  const quotes = sampleDiverse(items, 5).map((i) => ({
    reviewId: i.id,
    date: i.review_date.slice(0, 10),
    rating: i.rating,
    locale: i.locale,
    evidence: i.evidence,
  }));

  if (!evidences.length) {
    const empty: SummarizeReviewsResult = {
      filters: filterRecord,
      scopeLabel,
      total,
      evidenceUsed: 0,
      coveredAll: total === 0,
      truncated,
      fromCache: false,
      llmCalls: 0,
      themes: [],
      representativeQuotes: [],
      note: total > 0 ? "有评论但无可用 evidence（可能未分类或缺 evidence 字段）" : "筛选下无评论",
    };
    setCachedScopedReviewSummary(cached.key, empty);
    return empty;
  }

  const { themes, llmCalls } = await mapReduceSummarizeEvidence({
    apiKey,
    scopeLabel,
    evidences,
    appContext: appContext ?? undefined,
  });

  const coveredAll = !truncated && evidenceUsedEqualsTotal(evidences.length, total);

  const result: SummarizeReviewsResult = {
    filters: filterRecord,
    scopeLabel,
    total,
    evidenceUsed: evidences.length,
    coveredAll,
    truncated,
    fromCache: false,
    llmCalls,
    themes,
    representativeQuotes: quotes,
    note: buildSummarizeNote({ total, evidenceUsed: evidences.length, truncated, coveredAll, llmCalls }),
  };

  setCachedScopedReviewSummary(cached.key, result);
  return result;
}

function evidenceUsedEqualsTotal(evidenceUsed: number, total: number): boolean {
  return evidenceUsed >= total;
}

function buildSummarizeNote(opts: {
  total: number;
  evidenceUsed: number;
  truncated: boolean;
  coveredAll: boolean;
  llmCalls: number;
}): string {
  const parts = [
    `基于 ${opts.evidenceUsed}/${opts.total} 条评论的 evidence 做主题归纳（非原文抽样）`,
    opts.coveredAll
      ? "已覆盖该筛选下全部评论"
      : opts.truncated
        ? `超过单次上限 ${ASK_SUMMARIZE_MAX} 条，仅前 ${opts.evidenceUsed} 条纳入归纳`
        : `evidence 可用 ${opts.evidenceUsed} 条，与 total ${opts.total} 不一致时可能有个别评论缺 evidence`,
    `LLM 调用 ${opts.llmCalls} 次`,
  ];
  return parts.join("；");
}
