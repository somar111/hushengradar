import { sortSubTagRecordForDisplay } from "./analysisShared";
import { buildAnalysisMetrics, computeStats, countReviewsMatching, queryReviews } from "./reviews";
import type { ReviewRow } from "./supabase";

export type AskContext = {
  appId: string;
  appContext?: string | null;
  latestReviewDate: string | null;
  defaultSince?: string;
  defaultLocale?: string;
  timeRangeLabel: string;
};

type DateFilters = {
  since?: string;
  until?: string;
  locale?: string;
};

function resolveFilters(
  args: Record<string, unknown>,
  defaults: Pick<AskContext, "defaultSince" | "defaultLocale">
): DateFilters {
  return {
    since: typeof args.since === "string" && args.since ? args.since : defaults.defaultSince,
    until: typeof args.until === "string" && args.until ? args.until : undefined,
    locale: typeof args.locale === "string" && args.locale ? args.locale : defaults.defaultLocale,
  };
}

function compactReview(r: ReviewRow) {
  return {
    date: r.review_date.slice(0, 10),
    rating: r.rating,
    locale: r.locale,
    version: r.app_version,
    tags: (r.ai_tags ?? []).map((t) => ({
      label: t.label,
      sub: t.subLabel ?? null,
      evidence: t.evidence ?? null,
    })),
    text: r.translated_zh || r.content,
    originalLang: r.detected_lang,
    hasOfficialReply: !!r.official_reply,
  };
}

export const ASK_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "get_stats",
      description:
        "获取指定时间/地区范围内的聚合统计：评论总数、日期范围、星级分布、均分、标签分布（含子问题）、版本评分、官方回复率等。子标签 count 是标签命中次数（一条评论多 tag 会多次计数），不是评论条数——问「某标签/子标签有多少条评论」必须用 count_reviews。",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "起始时间 ISO 8601（含）" },
          until: { type: "string", description: "截止时间 ISO 8601（含）" },
          locale: { type: "string", description: "抓取批次 locale，格式 lang_country，如 en_us" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_locales",
      description: "列出指定时间范围内各地区的评论数量与均分，用于确认 locale 代码或对比市场。",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "起始时间 ISO 8601（含）" },
          until: { type: "string", description: "截止时间 ISO 8601（含）" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "count_reviews",
      description:
        "统计符合条件的评论条数（与 Demo 评论查看&回复列表完全同一套筛选）。用户问「某顶层标签/子标签有多少条评论」时必须优先调用；UI 上的「其他」对应 subTag=general。返回 total 即精确条数。",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "起始时间 ISO 8601（含）" },
          until: { type: "string", description: "截止时间 ISO 8601（含）" },
          locale: { type: "string", description: "抓取批次 locale，如 en_us" },
          tag: { type: "string", description: "顶层标签 key，如 content_features" },
          subTag: { type: "string", description: "子标签 subKey；「其他」填 general" },
          rating: { type: "number", description: "筛选星级 1-5" },
          q: { type: "string", description: "关键词（可选）" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query_reviews",
      description:
        "查询真实评论样本（含原文/中文翻译、AI 标签、评分）。用于了解用户具体在抱怨或称赞什么，也支持按关键词检索。返回 total 与抽样条数。仅问条数时用 count_reviews；需要摘录原文时用本工具并看 returned 样本。",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "起始时间 ISO 8601（含）" },
          until: { type: "string", description: "截止时间 ISO 8601（含）" },
          locale: { type: "string", description: "抓取批次 locale，如 en_us" },
          tag: { type: "string", description: "AI 标签 key，如 billing、feature_request" },
          subTag: { type: "string", description: "子问题 subKey，需与 tag 一起使用" },
          rating: { type: "number", description: "筛选星级 1-5" },
          q: { type: "string", description: "关键词，模糊匹配评论原文、中英文翻译与作者名（如『印度』或『India』）。问『有没有提到X』时用它，并放宽时间范围覆盖全部数据" },
          limit: { type: "number", description: "返回条数，默认 15，最多 30" },
        },
      },
    },
  },
];

export async function executeAskTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AskContext
): Promise<string> {
  const { since, until, locale } = resolveFilters(args, ctx);

  if (name === "get_stats") {
    const stats = await computeStats(ctx.appId, locale, since, until, {
      appContext: ctx.appContext,
    });
    const metrics = buildAnalysisMetrics(stats);
    return JSON.stringify({
      filters: { since: since ?? null, until: until ?? null, locale: locale ?? null },
      dateRange: stats.dateRange,
      ...metrics,
      tagSummaries: Object.fromEntries(
        Object.entries(stats.tagCounts).map(([key, t]) => [key, t.summary]).filter(([, s]) => s)
      ),
      subTagBreakdown: Object.fromEntries(
        Object.entries(stats.tagCounts).map(([key, t]) => [
          key,
          sortSubTagRecordForDisplay(t.subTags).map(([subKey, s]) => ({
            subKey,
            label: s.label,
            count: s.count,
          })),
        ])
      ),
    });
  }

  if (name === "list_locales") {
    const stats = await computeStats(ctx.appId, undefined, since, until, {
      appContext: ctx.appContext,
    });
    return JSON.stringify({
      filters: { since: since ?? null, until: until ?? null },
      dateRange: stats.dateRange,
      locales: stats.localeRatings.map((l) => ({
        locale: l.locale,
        reviewCount: l.count,
        avgRating: l.avgRating,
      })),
    });
  }

  if (name === "count_reviews") {
    const tag = typeof args.tag === "string" ? args.tag : undefined;
    const subTag = typeof args.subTag === "string" ? args.subTag : undefined;
    const rating = typeof args.rating === "number" ? args.rating : undefined;
    const q = typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined;
    const total = await countReviewsMatching({
      appId: ctx.appId,
      since,
      until,
      locale,
      tag,
      subTag,
      rating,
      q,
    });
    return JSON.stringify({
      filters: {
        since: since ?? null,
        until: until ?? null,
        locale: locale ?? null,
        tag: tag ?? null,
        subTag: subTag ?? null,
        rating: rating ?? null,
        q: q ?? null,
      },
      total,
      note: "total 为评论条数，与 Demo 评论列表同口径；子标签「其他」= subTag general",
    });
  }

  if (name === "query_reviews") {
    const limit = Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : 15));
    const tag = typeof args.tag === "string" ? args.tag : undefined;
    const subTag = typeof args.subTag === "string" ? args.subTag : undefined;
    const rating = typeof args.rating === "number" ? args.rating : undefined;
    const q = typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined;
    const { items, total } = await queryReviews({
      appId: ctx.appId,
      since,
      until,
      locale,
      tag,
      subTag,
      rating,
      q,
      page: 1,
      pageSize: limit,
    });
    return JSON.stringify({
      filters: {
        since: since ?? null,
        until: until ?? null,
        locale: locale ?? null,
        tag: tag ?? null,
        subTag: subTag ?? null,
        rating: rating ?? null,
        q: q ?? null,
      },
      total,
      returned: items.length,
      reviews: items.map(compactReview),
    });
  }

  return JSON.stringify({ error: `未知工具：${name}` });
}
