import { buildCategoryCatalog } from "./promptKit.mjs";
import { countReviewsMatching } from "./reviews";
import type { AskContext } from "./askTools";

export type SeedCategory = {
  key: string;
  label: string;
  subcategories?: { key: string; label: string }[];
};

export type UniversalSubcategories = Record<string, { key: string; label: string }[]>;

/** 通用类 + App taxonomy，与分类/Top 反馈展示一致 */
export function buildAskCategoryCatalog(
  seedCategories: SeedCategory[] | null | undefined,
  universalSubcategories?: UniversalSubcategories | null
): SeedCategory[] {
  return buildCategoryCatalog(seedCategories ?? [], universalSubcategories ?? {}) as SeedCategory[];
}

const COUNT_QUESTION_RE =
  /(?:有多少|多少条|几条|共计|总数|数量|共\s*\d|\d+\s*条|count\s+of|how\s+many)/i;

const TAG_SCOPE_QUESTION_RE =
  /(?:有多少|多少条|几条|共计|总数|数量|抱怨|投诉|骂|说什么|讲什么|内容|主题|概况|集中在|complain|complaining|about what|what are)/i;

const NON_TAG_COUNT_RE = /星级|评分|均分|回复率|版本|locale|地区.*均/i;

const CATCH_ALL_RE = /其他|其它|\bgeneral\b/i;

const EXISTENCE_QUESTION_RE =
  /(?:有没有|是否存在|是否|有.{0,16}评论|评论.{0,12}(提到|要求|想要|希望|要))|(?:吗[？?]\s*$)/i;

function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

export function isTagCountQuestion(question: string): boolean {
  const q = question.trim();
  if (!q || !COUNT_QUESTION_RE.test(q)) return false;
  if (NON_TAG_COUNT_RE.test(q)) return false;
  return true;
}

/** 条数预查 / summarize 前置：问题涉及某标签的条数或内容归纳 */
export function shouldPrefetchTagScope(
  question: string,
  catalog?: SeedCategory[] | null
): boolean {
  const q = question.trim();
  if (!q || NON_TAG_COUNT_RE.test(q)) return false;
  if (isTagCountQuestion(q) || TAG_SCOPE_QUESTION_RE.test(q)) return true;
  // 「功能请求 的其他」等：能解析出 tag 范围即预查条数
  return resolveTagRefsFromQuestion(question, catalog) !== null;
}

/** 从问题文本 + taxonomy 解析顶层 tag / 子 tag（「其他」→ general）。含 feature_request 等通用类。 */
export function resolveTagRefsFromQuestion(
  question: string,
  catalog: SeedCategory[] | null | undefined
): { tag: string; tagLabel: string; subTag?: string; subLabel?: string } | null {
  if (!catalog?.length) return null;
  const qNorm = normalizeForMatch(question);

  let bestParent: SeedCategory | null = null;
  let bestParentLen = 0;
  let bestParentExact = false;

  for (const cat of catalog) {
    const labelNorm = normalizeForMatch(cat.label);
    const keyNorm = normalizeForMatch(cat.key);
    const exactLabel = labelNorm.length >= 2 && qNorm === labelNorm;
    const labelHit = labelNorm.length >= 2 && qNorm.includes(labelNorm);
    const keyHit = keyNorm.length > 4 && qNorm.includes(keyNorm);
    if (exactLabel || labelHit || keyHit) {
      const len = exactLabel ? labelNorm.length + 1000 : labelHit ? labelNorm.length : keyNorm.length;
      const exact = exactLabel;
      if (len > bestParentLen || (len === bestParentLen && exact && !bestParentExact)) {
        bestParent = cat;
        bestParentLen = len;
        bestParentExact = exact;
      }
    }
  }
  if (!bestParent) return null;

  let bestSub: { key: string; label: string } | null = null;
  let bestSubLen = 0;

  for (const sub of bestParent.subcategories ?? []) {
    const subNorm = normalizeForMatch(sub.label);
    const subKeyNorm = normalizeForMatch(sub.key);
    const labelHit = subNorm.length >= 2 && qNorm.includes(subNorm);
    const keyHit = subKeyNorm.length > 4 && qNorm.includes(subKeyNorm);
    if (labelHit || keyHit) {
      const len = labelHit ? subNorm.length : subKeyNorm.length;
      if (len > bestSubLen) {
        bestSub = sub;
        bestSubLen = len;
      }
    }
  }

  if (!bestSub && CATCH_ALL_RE.test(question)) {
    bestSub = { key: "general", label: "其他" };
  }

  return {
    tag: bestParent.key,
    tagLabel: bestParent.label,
    subTag: bestSub?.key,
    subLabel: bestSub?.label,
  };
}

/** 在 LLM 调工具前预查 count_reviews 同口径条数（条数问法 + 某标签内容/抱怨归纳问法）。 */
export async function prefetchAskTagScope(
  ctx: AskContext,
  question: string
): Promise<{ block: string; total: number; refs: NonNullable<ReturnType<typeof resolveTagRefsFromQuestion>> } | null> {
  const catalog = buildAskCategoryCatalog(ctx.seedCategories, ctx.universalSubcategories);
  if (!shouldPrefetchTagScope(question, catalog)) return null;
  const refs = resolveTagRefsFromQuestion(question, catalog);
  if (!refs) return null;

  const total = await countReviewsMatching({
    appId: ctx.appId,
    since: ctx.defaultSince,
    locale: ctx.defaultLocale,
    tag: refs.tag,
    subTag: refs.subTag,
  });

  const scopeParts = [ctx.timeRangeLabel];
  if (ctx.defaultLocale) scopeParts.push(`地区=${ctx.defaultLocale}`);

  const tagPath = refs.subTag
    ? `「${refs.tagLabel}」→「${refs.subLabel ?? refs.subTag}」`
    : `「${refs.tagLabel}」`;

  const block = [
    "【系统预查·评论条数（权威，不可改写数字）】",
    `已执行 count_reviews：${tagPath}（tag=${refs.tag}${refs.subTag ? `, subTag=${refs.subTag}` : ""}）`,
    `范围：${scopeParts.join("，")}${ctx.defaultSince ? `（since=${ctx.defaultSince.slice(0, 10)}）` : ""}`,
    `total=${total}（与 Demo 评论查看&回复 / Top 反馈列表同口径）`,
    `作答开头须写「共 ${total} 条评论」——禁止写 evidenceUsed 或其它数字代替 total。`,
    `调用 summarize_reviews 时必须传 tag="${refs.tag}"${refs.subTag ? `, subTag="${refs.subTag}"` : ""}（与上文一致）；勿换成其它顶层标签。`,
    "调用 summarize_reviews 后仍以 total 为评论总条数。evidenceUsed 仅为纳入归纳的条数，notSummarized 为因上限未扫描的条数，禁止把 evidenceUsed+excludedNoText 相加当作 total。",
    refs.subTag === "general"
      ? "「其他」是兜底子类，不含同顶层下具名子标签里的评论；勿把 sibling 子标签分布当成「其他」的内容。"
      : null,
    `作答涉及条数时只引用 total=${total}。`,
  ]
    .filter(Boolean)
    .join("\n");

  return { block, total, refs };
}

/** 存在性/关键词问法：注入检索路径提示，避免连环调工具耗尽轮次。 */
export function prefetchAskExistenceHint(question: string): { block: string } | null {
  const q = question.trim();
  if (!q || !EXISTENCE_QUESTION_RE.test(q)) return null;
  if (isTagCountQuestion(q)) return null;

  return {
    block: [
      "【系统提示·存在性/关键词检索】",
      "开发者问的是「有没有某类评论」或类似存在性问题。",
      "优先单次 query_reviews：q 填问题里的核心名词（如功能名、角色名、「新英雄」），since 传很早的日期以覆盖全库；以返回的 total 判断有没有，再用 quotes 补 2～3 条例证后即作答。",
      "不要为猜 tag/subTag 连环调 get_stats、list_locales、多次 count_reviews。",
    ].join("\n"),
  };
}

/** @deprecated 使用 prefetchAskTagScope */
export async function prefetchAskTagCount(
  ctx: AskContext,
  question: string
): Promise<{ block: string; total: number } | null> {
  const r = await prefetchAskTagScope(ctx, question);
  return r ? { block: r.block, total: r.total } : null;
}
