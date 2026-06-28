import {
  buildAskCategoryCatalog,
  resolveTagRefsFromQuestion,
  type SeedCategory,
  type UniversalSubcategories,
} from "./askCountPrefetch";

export type AskThreadScope = { tag: string; subTag?: string };

/** 明显在问全局/聚合、而非延续某一标签话题 */
const ASK_BROAD_SCOPE_RE =
  /(?:所有评论|全部评论|所有问题|全部问题|整个(?:时间|范围)|全库|不限于|换个话题|另外(?:问|看)|整体(?:均分|评分|星级|分布|分析|情况|来看)|总(?:体)?均分|评分分布|星级占比|回复率|产品经理|\bPM\b|优先(?:级|处理)|最先(?:要)?处理|哪[一二三四五六七八九十\d两三]+(?:个|项|类|方面|问题)|top\s*\d|最重要的|三大|三类|各类|各个分类|所有分类|跨类|全局|全面|概览|综览|除了.{0,12}还有)/i;

/** 明显在延续上一轮分类话题的追问 */
const ASK_FOLLOW_UP_RE =
  /(?:这类|它们|这些|这条|上面|刚才|前述|继续|还有|为何|为什么|怎么办|回复率|举例|再举|详细|展开|细分|用户们|抱怨什么|说什么|集中在|分布如何|占比|严重程度|再分析|补充)/i;

export function isAskBroadScopeQuestion(question: string): boolean {
  const q = question.trim();
  return Boolean(q && ASK_BROAD_SCOPE_RE.test(q));
}

export function isAskFollowUpQuestion(question: string): boolean {
  const q = question.trim();
  return Boolean(q && ASK_FOLLOW_UP_RE.test(q));
}

export function labelForAskScope(scope: AskThreadScope, catalog: SeedCategory[]): string {
  const parent = catalog.find((c) => c.key === scope.tag);
  const parentLabel = parent?.label ?? scope.tag;
  if (!scope.subTag) return parentLabel;
  const subLabel = parent?.subcategories?.find((s) => s.key === scope.subTag)?.label;
  return subLabel ? `${parentLabel} / ${subLabel}` : parentLabel;
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

function resolveScopeWithoutAmbiguity(
  question: string,
  catalog: SeedCategory[],
  previousScope: AskThreadScope | null,
  entryScope?: AskThreadScope | null
): AskThreadScope | null {
  const q = question.trim();
  if (!q) return previousScope;

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

export type AskScopeClarifyOptions = {
  timeRangeLabel: string;
  globalReviewTotal?: number;
  scopedReviewCount?: number;
};

export type AskScopeTurnPlan =
  | { action: "send"; scope: AskThreadScope | null }
  | {
      action: "clarify";
      inheritedScope: AskThreadScope;
      optionALabel: string;
      optionBLabel: string;
    };

/**
 * 决定本条问 AI 的 scope，并在「会继承上一轮分类但语义不明」时要求用户 A/B 选择。
 */
export function planAskScopeTurn(
  question: string,
  seedCategories: SeedCategory[] | null | undefined,
  universalSubcategories: UniversalSubcategories | null | undefined,
  previousScope: AskThreadScope | null,
  entryScope: AskThreadScope | null | undefined,
  clarifyOptions: AskScopeClarifyOptions
): AskScopeTurnPlan {
  const q = question.trim();
  const catalog = buildAskCategoryCatalog(seedCategories, universalSubcategories);
  const scope = resolveScopeWithoutAmbiguity(q, catalog, previousScope, entryScope);

  const inheritsPrevious =
    Boolean(previousScope) &&
    !entryScope &&
    !resolveTagRefsFromQuestion(q, catalog) &&
    !isAskBroadScopeQuestion(q) &&
    scope?.tag === previousScope?.tag &&
    (scope?.subTag ?? undefined) === (previousScope?.subTag ?? undefined);

  if (inheritsPrevious && previousScope && !isAskFollowUpQuestion(q)) {
    const scopeLabel = labelForAskScope(previousScope, catalog);
    const countA = clarifyOptions.scopedReviewCount;
    const countB = clarifyOptions.globalReviewTotal;
    return {
      action: "clarify",
      inheritedScope: previousScope,
      optionALabel: `继续只看「${scopeLabel}」${countA != null ? `（${countA.toLocaleString()} 条）` : ""}`,
      optionBLabel: `看${clarifyOptions.timeRangeLabel}全部评论${countB != null ? `（${countB.toLocaleString()} 条）` : ""}`,
    };
  }

  return { action: "send", scope };
}

/**
 * 决定本条问 AI 请求的 tag/subTag 限定（与会话级 askThreadScope 配合）。
 */
export function resolveAskScopeForTurn(
  question: string,
  seedCategories: SeedCategory[] | null | undefined,
  universalSubcategories: UniversalSubcategories | null | undefined,
  previousScope: AskThreadScope | null,
  entryScope?: AskThreadScope | null
): AskThreadScope | null {
  const catalog = buildAskCategoryCatalog(seedCategories, universalSubcategories);
  return resolveScopeWithoutAmbiguity(question, catalog, previousScope, entryScope);
}
