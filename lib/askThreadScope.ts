import {
  buildAskCategoryCatalog,
  resolveTagRefsFromQuestion,
  type SeedCategory,
  type UniversalSubcategories,
} from "./askCountPrefetch";

export type AskThreadScope = { tag: string; subTag?: string };

/** 明显在问全局/聚合、而非延续某一标签话题 */
const ASK_BROAD_SCOPE_RE =
  /(?:所有评论|全部评论|所有问题|全部问题|整个(?:时间|范围)|全库|不限于|换个话题|另外(?:问|看)|整体(?:均分|评分|星级|分布)|总(?:体)?均分|评分分布|星级占比|回复率)/i;

export function isAskBroadScopeQuestion(question: string): boolean {
  const q = question.trim();
  return Boolean(q && ASK_BROAD_SCOPE_RE.test(q));
}

/**
 * 决定本条问 AI 请求的 tag/subTag 限定（与会话级 askThreadScope 配合）。
 * 1. 问题文本能解析出标签 → 采用（含从子分类预填后用户未删改的首问）
 * 2. 明显问全局 → 不限定
 * 3. 否则若有上一轮 scope → 追问继承
 */
export function resolveAskScopeForTurn(
  question: string,
  seedCategories: SeedCategory[] | null | undefined,
  universalSubcategories: UniversalSubcategories | null | undefined,
  previousScope: AskThreadScope | null
): AskThreadScope | null {
  const q = question.trim();
  if (!q) return previousScope;

  const catalog = buildAskCategoryCatalog(seedCategories, universalSubcategories);
  const refs = resolveTagRefsFromQuestion(q, catalog);
  if (refs) {
    return { tag: refs.tag, subTag: refs.subTag };
  }

  if (isAskBroadScopeQuestion(q)) {
    return null;
  }

  return previousScope;
}
