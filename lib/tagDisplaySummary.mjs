// Top 反馈展示摘要的 scope 判定与同步解析（全局 tag_summaries）。
// 带筛选的展示摘要走 tagSummaries.summarizeTagsForScope（与 cron 同一 summarizeCluster 管线）。

import { hasSubTagBreakdown } from "./promptKit.mjs";

/** tag_summaries 仅对应全库无筛选视图；任一维度收窄则须 scoped summarize，禁止直出 evidence。 */
export function hasActiveStatsScope({ locale, since, until } = {}) {
  return Boolean(locale || since || until);
}

/**
 * 无筛选 stats 视图：从离线 tag_summaries 取展示短语。
 * @param {object} opts
 * @param {string|null|undefined} opts.globalSummary
 * @param {Record<string, { label: string, count: number }>} opts.subTags
 */
export function resolveGlobalTagDisplaySummary({ globalSummary, subTags }) {
  if (hasSubTagBreakdown(subTags)) return null;
  return globalSummary?.trim() || null;
}
