import { summarizeReviewsForAsk } from "./askSummarize";
import { sortSubTagRecordForDisplay } from "./analysisShared";
import { buildAnalysisMetrics, computeStats, countReviewsMatching, queryReviews } from "./reviews";
import type { AiTag, ReviewRow } from "./supabase";

export type AskContext = {
  appId: string;
  appContext?: string | null;
  latestReviewDate: string | null;
  defaultSince?: string;
  defaultLocale?: string;
  timeRangeLabel: string;
  seedCategories?: { key: string; label: string; subcategories?: { key: string; label: string }[] }[] | null;
};

type DateFilters = {
  since?: string;
  until?: string;
  locale?: string;
};

type ReviewFilterArgs = {
  tag?: string;
  subTag?: string;
  rating?: number;
  q?: string;
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

function parseReviewFilters(args: Record<string, unknown>): ReviewFilterArgs {
  return {
    tag: typeof args.tag === "string" ? args.tag : undefined,
    subTag: typeof args.subTag === "string" ? args.subTag : undefined,
    rating: typeof args.rating === "number" ? args.rating : undefined,
    q: typeof args.q === "string" && args.q.trim() ? args.q.trim() : undefined,
  };
}

function evidenceForRow(r: ReviewRow, tag?: string, subTag?: string): string | null {
  const tags = r.ai_tags ?? [];
  let matched: AiTag | undefined;
  if (tag && subTag) matched = tags.find((t) => t.key === tag && t.subKey === subTag);
  else if (tag) matched = tags.find((t) => t.key === tag);
  const text = String(matched?.evidence ?? "").trim() || String(r.translated_zh || r.content || "").trim();
  return text || null;
}

function compactReviewQuote(r: ReviewRow, tag?: string, subTag?: string) {
  return {
    reviewId: r.id,
    date: r.review_date.slice(0, 10),
    rating: r.rating,
    locale: r.locale,
    evidence: evidenceForRow(r, tag, subTag),
  };
}

function compactReviewFull(r: ReviewRow) {
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
          locale: { type: "string", description: "抓取批次 locale，格式 lang_country，如 en_us" },
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
      name: "summarize_reviews",
      description:
        "对筛选条件下全部评论做主题归纳（读取分类时已写入的 evidence 语义片段，非原文抽样）。用户问「这些评论在抱怨/称赞什么」「内容是什么」「查看全部再回答」时必须优先调用；与 count_reviews 同套 tag/subTag/locale/时间筛选。返回 total、themes、代表引用；evidenceUsed 为纳入归纳的条数。",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "起始时间 ISO 8601（含）" },
          until: { type: "string", description: "截止时间 ISO 8601（含）" },
          locale: { type: "string", description: "抓取批次 locale，如 en_us" },
          tag: { type: "string", description: "顶层标签 key" },
          subTag: { type: "string", description: "子标签 subKey；「其他」填 general" },
          rating: { type: "number", description: "筛选星级 1-5" },
          q: { type: "string", description: "关键词（可选，与列表同口径）" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "query_reviews",
      description:
        "查询少量评论样本作代表引用或关键词 existence 检查。归纳主题必须用 summarize_reviews，不要用本工具代替。mode=quotes（默认）只返回 evidence+元数据；mode=full 含译文/原文。支持 page 翻页。",
      parameters: {
        type: "object",
        properties: {
          since: { type: "string", description: "起始时间 ISO 8601（含）" },
          until: { type: "string", description: "截止时间 ISO 8601（含）" },
          locale: { type: "string", description: "抓取批次 locale，如 en_us" },
          tag: { type: "string", description: "AI 标签 key" },
          subTag: { type: "string", description: "子问题 subKey，需与 tag 一起使用" },
          rating: { type: "number", description: "筛选星级 1-5" },
          q: {
            type: "string",
            description:
              "关键词，模糊匹配评论原文、中英文翻译与作者名。问『有没有提到X』时用它；以 total 为准，不要只看 returned 几条",
          },
          mode: { type: "string", enum: ["quotes", "full"], description: "quotes=仅 evidence（默认）；full=含全文" },
          page: { type: "number", description: "页码，从 1 开始，默认 1" },
          limit: { type: "number", description: "每页条数，默认 5（quotes）或 15（full），最多 30" },
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
  const reviewFilters = parseReviewFilters(args);

  if (name === "get_stats") {
    const stats = await computeStats(ctx.appId, locale, since, until, {
      appContext: ctx.appContext,
    });
    const metrics = buildAnalysisMetrics(stats);
    return JSON.stringify({
      filters: { since: since ?? null, until: until ?? null, locale: locale ?? null },
      dateRange: stats.dateRange,
      countDisclaimer:
        "subTagBreakdown[].count 是标签命中次数，不是评论条数；问「某标签/子标签有多少条评论」须用 count_reviews.total。",
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
    const total = await countReviewsMatching({
      appId: ctx.appId,
      since,
      until,
      locale,
      ...reviewFilters,
    });
    return JSON.stringify({
      filters: {
        since: since ?? null,
        until: until ?? null,
        locale: locale ?? null,
        tag: reviewFilters.tag ?? null,
        subTag: reviewFilters.subTag ?? null,
        rating: reviewFilters.rating ?? null,
        q: reviewFilters.q ?? null,
      },
      total,
      note: "total 为评论条数，与 Demo 评论查看&回复列表同口径；子标签「其他」= subTag general",
    });
  }

  if (name === "summarize_reviews") {
    const result = await summarizeReviewsForAsk({
      appId: ctx.appId,
      appContext: ctx.appContext,
      seedCategories: ctx.seedCategories,
      filters: {
        appId: ctx.appId,
        since,
        until,
        locale,
        ...reviewFilters,
      },
    });
    return JSON.stringify(result);
  }

  if (name === "query_reviews") {
    const mode = args.mode === "full" ? "full" : "quotes";
    const page = Math.max(1, typeof args.page === "number" ? Math.floor(args.page) : 1);
    const defaultLimit = mode === "full" ? 15 : 5;
    const limit = Math.min(30, Math.max(1, typeof args.limit === "number" ? args.limit : defaultLimit));
    const { tag, subTag, rating, q } = reviewFilters;
    const { items, total } = await queryReviews({
      appId: ctx.appId,
      since,
      until,
      locale,
      tag,
      subTag,
      rating,
      q,
      page,
      pageSize: limit,
    });
    const reviews =
      mode === "full" ? items.map(compactReviewFull) : items.map((r) => compactReviewQuote(r, tag, subTag));
    return JSON.stringify({
      filters: {
        since: since ?? null,
        until: until ?? null,
        locale: locale ?? null,
        tag: tag ?? null,
        subTag: subTag ?? null,
        rating: rating ?? null,
        q: q ?? null,
        mode,
        page,
      },
      total,
      returned: items.length,
      hasMore: page * limit < total,
      reviews,
      note:
        mode === "quotes"
          ? "代表引用/检索样本；主题归纳请用 summarize_reviews"
          : "全文模式；逐条看全部请翻页或引导用户去 Demo 评论列表",
    });
  }

  return JSON.stringify({ error: `未知工具：${name}` });
}
