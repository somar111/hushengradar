import {
  getCachedScopedReviewSummary,
  mapReduceSummarizeEvidence,
  sampleDiverse,
  setCachedScopedReviewSummary,
} from "./tagSummaries.mjs";
import {
  ASK_SUMMARIZE_MAX,
  countReviewsMatching,
  fetchReviewEvidenceForScope,
  type ReviewQueryFilters,
} from "./reviews";
import { localeLabel } from "./localeLabels";

export type SummarizeReviewsTheme = { label: string; description: string };

export type SummarizeReviewsResult = {
  filters: Record<string, string | number | null>;
  scopeLabel: string;
  /** 与 count_reviews / Demo 列表同口径的评论条数（权威） */
  total: number;
  /** 实际纳入主题归纳的条数（≤ total） */
  evidenceUsed: number;
  /** 无正文/evidence、未纳入归纳（不含因上限未扫描的） */
  excludedNoText: number;
  /** 因单次上限未拉取/未归纳的条数（truncated 时 > 0） */
  notSummarized: number;
  /** 本次实际拉取的行数（用于 cache 刷新时重算 notSummarized） */
  scanned: number;
  countDisclaimer: string;
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
    translatedZh?: string;
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

function deriveSummarizeCounts(opts: {
  listTotal: number;
  evidenceUsed: number;
  truncated: boolean;
  scanned: number;
  noTextInBatch: number;
}) {
  const { listTotal, evidenceUsed, truncated, scanned, noTextInBatch } = opts;
  if (truncated) {
    return {
      excludedNoText: noTextInBatch,
      notSummarized: Math.max(0, listTotal - scanned),
    };
  }
  // 未超 ASK 上限但 scanned < listTotal：PostgREST 单次 1000 行截断等 fetch 不足
  if (scanned < listTotal) {
    return {
      excludedNoText: noTextInBatch,
      notSummarized: Math.max(0, listTotal - scanned),
    };
  }
  return {
    excludedNoText: Math.max(0, listTotal - evidenceUsed),
    notSummarized: 0,
  };
}

function buildCountDisclaimer(opts: {
  total: number;
  evidenceUsed: number;
  excludedNoText: number;
  notSummarized: number;
  truncated: boolean;
}): string {
  const { total, evidenceUsed, excludedNoText, notSummarized, truncated } = opts;
  const base = `列表共 ${total} 条（与 Demo 评论查看&回复 / count_reviews 同口径，这是唯一条数答案，禁止用 evidenceUsed+excludedNoText+notSummarized 自行相加代替 total）。`;
  if (truncated) {
    const parts = [`本次主题归纳纳入 ${evidenceUsed} 条`];
    if (excludedNoText > 0) parts.push(`${excludedNoText} 条无正文未纳入`);
    if (notSummarized > 0) parts.push(`${notSummarized} 条因单次上限 ${ASK_SUMMARIZE_MAX} 未纳入本次归纳（不是无正文）`);
    return `${base} ${parts.join("；")}。作答时必须先说「共 ${total} 条」，不要只说 ${evidenceUsed} 或把 ${evidenceUsed}+${excludedNoText} 当成总数。`;
  }
  if (notSummarized > 0) {
    const parts = [`本次主题归纳纳入 ${evidenceUsed} 条`];
    if (excludedNoText > 0) parts.push(`${excludedNoText} 条无正文未纳入`);
    parts.push(`${notSummarized} 条因拉取不完整未纳入归纳`);
    return `${base} ${parts.join("；")}。作答必须以 ${total} 为评论条数。`;
  }
  if (excludedNoText > 0) {
    return `${base} 其中 ${evidenceUsed} 条有正文/evidence 并参与主题归纳，${excludedNoText} 条因无正文未纳入。作答必须以 ${total} 为评论条数。`;
  }
  return `${base} 全部 ${total} 条均参与主题归纳。`;
}

function buildSummarizeNote(opts: {
  total: number;
  evidenceUsed: number;
  excludedNoText: number;
  notSummarized: number;
  truncated: boolean;
  coveredAll: boolean;
  llmCalls: number;
}): string {
  const parts = [
    `主题归纳基于 ${opts.evidenceUsed}/${opts.total} 条 evidence`,
    opts.coveredAll
      ? "已覆盖该筛选下全部评论"
      : opts.truncated
        ? `单次上限 ${ASK_SUMMARIZE_MAX}：${opts.notSummarized} 条未扫描归纳${opts.excludedNoText > 0 ? `，已扫描中 ${opts.excludedNoText} 条无正文` : ""}；总条数仍为 ${opts.total}`
        : opts.notSummarized > 0
          ? `拉取不完整：${opts.notSummarized} 条未纳入归纳${opts.excludedNoText > 0 ? `，已拉取中 ${opts.excludedNoText} 条无正文` : ""}；总条数仍为 ${opts.total}`
          : opts.excludedNoText > 0
            ? `${opts.excludedNoText} 条无正文未纳入；总条数仍为 ${opts.total}`
            : null,
    `LLM 调用 ${opts.llmCalls} 次`,
  ].filter(Boolean);
  return parts.join("；");
}

function applyListTotalToResult(result: SummarizeReviewsResult, listTotal: number): SummarizeReviewsResult {
  const scanned =
    result.scanned ??
    (result.truncated
      ? Math.min(listTotal, ASK_SUMMARIZE_MAX)
      : result.evidenceUsed + (result.excludedNoText ?? 0));
  const { excludedNoText, notSummarized } = deriveSummarizeCounts({
    listTotal,
    evidenceUsed: result.evidenceUsed,
    truncated: result.truncated,
    scanned,
    noTextInBatch: result.truncated ? result.excludedNoText : 0,
  });
  const coveredAll = !result.truncated && result.evidenceUsed >= listTotal;
  return {
    ...result,
    total: listTotal,
    excludedNoText,
    notSummarized,
    coveredAll,
    countDisclaimer: buildCountDisclaimer({
      total: listTotal,
      evidenceUsed: result.evidenceUsed,
      excludedNoText,
      notSummarized,
      truncated: result.truncated,
    }),
    note: buildSummarizeNote({
      total: listTotal,
      evidenceUsed: result.evidenceUsed,
      excludedNoText,
      notSummarized,
      truncated: result.truncated,
      coveredAll,
      llmCalls: result.llmCalls,
    }),
    fromCache: true,
  };
}

export async function summarizeReviewsForAsk(opts: {
  appId: string;
  appContext?: string | null;
  seedCategories?: { key: string; label: string; subcategories?: { key: string; label: string }[] }[] | null;
  filters: ReviewQueryFilters;
}): Promise<SummarizeReviewsResult> {
  const { appContext, seedCategories, filters } = opts;
  const { appId, tag, subTag, locale, since, until, rating, q } = filters;

  const scopeLabel = resolveScopeLabel(seedCategories, tag, subTag);
  const filterRecord = {
    since: since ?? null,
    until: until ?? null,
    locale: locale ?? null,
    localeLabel: localeLabel(locale),
    tag: tag ?? null,
    subTag: subTag ?? null,
    rating: rating ?? null,
    q: q ?? null,
  };

  const listTotal = await countReviewsMatching(filters);

  const cached = getCachedScopedReviewSummary(appId, locale, since, until, tag, subTag, q, rating);
  if (cached.payload) {
    return applyListTotalToResult(cached.payload as SummarizeReviewsResult, listTotal);
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY 未配置");

  const { items, truncated, scanned, noTextInBatch } = await fetchReviewEvidenceForScope(filters);
  const evidences = items.map((i) => i.evidence);
  const evidenceUsed = evidences.length;
  const { excludedNoText, notSummarized } = deriveSummarizeCounts({
    listTotal,
    evidenceUsed,
    truncated,
    scanned,
    noTextInBatch,
  });
  const coveredAll = !truncated && evidenceUsed >= listTotal;

  const quotes = sampleDiverse(items, 5).map((i) => ({
    reviewId: i.id,
    date: i.review_date.slice(0, 10),
    rating: i.rating,
    locale: i.locale,
    localeLabel: localeLabel(i.locale),
    evidence: i.evidence,
    ...(i.translated_zh ? { translatedZh: i.translated_zh } : {}),
  }));

  if (!evidences.length) {
    const empty: SummarizeReviewsResult = {
      filters: filterRecord,
      scopeLabel,
      total: listTotal,
      evidenceUsed: 0,
      excludedNoText: listTotal,
      notSummarized: 0,
      scanned: 0,
      countDisclaimer: buildCountDisclaimer({
        total: listTotal,
        evidenceUsed: 0,
        excludedNoText: listTotal,
        notSummarized: 0,
        truncated,
      }),
      coveredAll: listTotal === 0,
      truncated,
      fromCache: false,
      llmCalls: 0,
      themes: [],
      representativeQuotes: [],
      note: listTotal > 0 ? "有评论但无可用 evidence（可能未分类或缺 evidence 字段）" : "筛选下无评论",
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

  const result: SummarizeReviewsResult = {
    filters: filterRecord,
    scopeLabel,
    total: listTotal,
    evidenceUsed,
    excludedNoText,
    notSummarized,
    scanned,
    countDisclaimer: buildCountDisclaimer({
      total: listTotal,
      evidenceUsed,
      excludedNoText,
      notSummarized,
      truncated,
    }),
    coveredAll,
    truncated,
    fromCache: false,
    llmCalls,
    themes,
    representativeQuotes: quotes,
    note: buildSummarizeNote({
      total: listTotal,
      evidenceUsed,
      excludedNoText,
      notSummarized,
      truncated,
      coveredAll,
      llmCalls,
    }),
  };

  setCachedScopedReviewSummary(cached.key, result);
  return result;
}
