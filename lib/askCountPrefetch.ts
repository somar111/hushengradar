import { countReviewsMatching } from "./reviews";
import type { AskContext } from "./askTools";

export type SeedCategory = {
  key: string;
  label: string;
  subcategories?: { key: string; label: string }[];
};

const COUNT_QUESTION_RE =
  /(?:有多少|多少条|几条|共计|总数|数量|共\s*\d|\d+\s*条|count\s+of|how\s+many)/i;

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

/** 条数类问题：在 LLM 调工具前用 count_reviews 同口径预查，避免误用 get_stats。 */
export async function prefetchAskTagCount(
  ctx: AskContext & { seedCategories?: SeedCategory[] | null },
  question: string
): Promise<{ block: string; total: number } | null> {
  if (!isTagCountQuestion(question)) return null;
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
    `total=${total}（与 Demo 评论查看&回复列表同口径）`,
    refs.subTag === "general"
      ? "「其他」是兜底子类，不含同顶层下具名子标签里的评论；勿把 sibling 子标签分布当成「其他」的内容。"
      : null,
    "作答条数时只引用上述 total；禁止用 get_stats.subTagBreakdown.count 代替。",
  ]
    .filter(Boolean)
    .join("\n");

  return { block, total };
}
