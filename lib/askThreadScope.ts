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

function subLabelForScope(
  catalog: SeedCategory[],
  scope: AskThreadScope
): string | undefined {
  const parent = catalog.find((c) => c.key === scope.tag);
  if (!scope.subTag) return undefined;
  return parent?.subcategories?.find((s) => s.key === scope.subTag)?.label;
}

/**
 * 从子分类点进问 AI 时带入的精确 tag/subTag（keys），优先于纯文本歧义解析。
 * 仅当用户明显问全局，或文本明确指向另一组 tag/subTag 时才覆盖。
 */
function mergeEntryScopeWithText(
  question: string,
  catalog: SeedCategory[],
  entryScope: AskThreadScope
): AskThreadScope | null {
  if (isAskBroadScopeQuestion(question)) return null;

  const refs = resolveTagRefsFromQuestion(question, catalog);
  if (!refs) return entryScope;

  const textScope: AskThreadScope = { tag: refs.tag, subTag: refs.subTag };
  if (textScope.tag === entryScope.tag && textScope.subTag === entryScope.subTag) {
    return entryScope;
  }

  const entrySubLabel = subLabelForScope(catalog, entryScope);
  if (
    entryScope.subTag &&
    refs.subTag &&
    refs.subTag !== entryScope.subTag &&
    refs.subLabel &&
    entrySubLabel &&
    refs.subLabel !== entrySubLabel
  ) {
    return textScope;
  }

  if (entryScope.subTag && refs.subLabel && entrySubLabel && refs.subLabel === entrySubLabel) {
    return entryScope;
  }

  if (textScope.tag !== entryScope.tag) {
    return textScope;
  }

  return entryScope;
}

/**
 * 决定本条问 AI 请求的 tag/subTag 限定（与会话级 askThreadScope 配合）。
 * 1. 有点击入口 scope 时优先（解决跨父类同名子标签）
 * 2. 问题文本能解析出标签 → 采用
 * 3. 明显问全局 → 不限定
 * 4. 否则若有上一轮 scope → 追问继承
 */
export function resolveAskScopeForTurn(
  question: string,
  seedCategories: SeedCategory[] | null | undefined,
  universalSubcategories: UniversalSubcategories | null | undefined,
  previousScope: AskThreadScope | null,
  entryScope?: AskThreadScope | null
): AskThreadScope | null {
  const q = question.trim();
  if (!q) return previousScope;

  const catalog = buildAskCategoryCatalog(seedCategories, universalSubcategories);

  if (entryScope) {
    return mergeEntryScopeWithText(q, catalog, entryScope);
  }

  const refs = resolveTagRefsFromQuestion(q, catalog);
  if (refs) {
    return { tag: refs.tag, subTag: refs.subTag };
  }

  if (isAskBroadScopeQuestion(q)) {
    return null;
  }

  return previousScope;
}
