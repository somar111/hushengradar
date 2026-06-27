import { countReviewsMatching } from "./reviews";
import type { AskContext } from "./askTools";

export type SeedCategory = {
  key: string;
  label: string;
  subcategories?: { key: string; label: string }[];
};

const COUNT_QUESTION_RE =
  /(?:有多少|多少条|几条|共计|总数|数量|共\s*\d|\d+\s*条|count\s+of|how\s+many)/i;

const TAG_SCOPE_QUESTION_RE =
  /(?:有多少|多少条|几条|共计|总数|数量|抱怨|投诉|骂|说什么|讲什么|内容|主题|概况|集中在|complain|complaining|about what|what are)/i;

const NON_TAG_COUNT_RE = /星级|评分|均分|回复率|版本|locale|地区.*均/i;

const CATCH_ALL_RE = /其他|其它|\bgeneral\b/i;

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
export function shouldPrefetchTagScope(question: string): boolean {
  const q = question.trim();
  if (!q || NON_TAG_COUNT_RE.test(q)) return false;
  return isTagCountQuestion(q) || TAG_SCOPE_QUESTION_RE.test(q);
}

/** 从问题文本 + taxonomy 解析顶层 tag / 子 tag（「其他」→ general）。 */
export function resolveTagRefsFromQuestion(
  question: string,
  seedCategories: SeedCategory[] | null | undefined
): { tag: string; tagLabel: string; subTag?: string; subLabel?: string } | null {
  if (!seedCategories?.length) return null;
  const qNorm = normalizeForMatch(question);

  let bestParent: SeedCategory | null = null;
  let bestParentLen = 0;

  for (const cat of seedCategories) {
    const labelNorm = normalizeForMatch(cat.label);
    const keyNorm = normalizeForMatch(cat.key);
    const labelHit = labelNorm.length >= 2 && qNorm.includes(labelNorm);
    const keyHit = keyNorm.length > 4 && qNorm.includes(keyNorm);
    if (labelHit || keyHit) {
      const len = labelHit ? labelNorm.length : keyNorm.length;
      if (len > bestParentLen) {
        bestParent = cat;
        bestParentLen = len;
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
  ctx: AskContext & { seedCategories?: SeedCategory[] | null },
  question: string
): Promise<{ block: string; total: number; refs: NonNullable<ReturnType<typeof resolveTagRefsFromQuestion>> } | null> {
  if (!shouldPrefetchTagScope(question)) return null;
  const refs = resolveTagRefsFromQuestion(question, ctx.seedCategories);
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
    "调用 summarize_reviews 后也必须以 total 为评论总条数；evidenceUsed 仅为纳入归纳的条数，notSummarized 为因上限未扫描的条数，禁止把 evidenceUsed+excludedNoText 相加当作 total。",
    refs.subTag === "general"
      ? "「其他」是兜底子类，不含同顶层下具名子标签里的评论；勿把 sibling 子标签分布当成「其他」的内容。"
      : null,
    `作答涉及条数时只引用 total=${total}。`,
  ]
    .filter(Boolean)
    .join("\n");

  return { block, total, refs };
}

/** @deprecated 使用 prefetchAskTagScope */
export async function prefetchAskTagCount(
  ctx: AskContext & { seedCategories?: SeedCategory[] | null },
  question: string
): Promise<{ block: string; total: number } | null> {
  const r = await prefetchAskTagScope(ctx, question);
  return r ? { block: r.block, total: r.total } : null;
}
