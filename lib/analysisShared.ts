// 前端（客户端组件）和后端（API/服务端）都要用的纯函数，放这里——不依赖任何服务端代码
// （比如 Supabase service client），所以客户端 import 不会把服务端逻辑/密钥打进前端包。

// 地区满意度对比的样本量下限——低于这个数的地区均分没有统计意义。不论是前端列表展示还是
// 喂给AI下"地区差距"结论，都要用同一个门槛，否则会出现"AI说德国(8条)最差，但列表里根本
// 没有德国"这种自相矛盾。相对+绝对自适应，跟具体App无关。
export function meaningfulLocaleFloor(total: number): number {
  return Math.max(20, Math.round(total * 0.02));
}

/** 兜底子问题：分类侧统一用 general(其他)，展示时永远沉底 */
export function isCatchAllSubTag(subKey: string, label?: string | null): boolean {
  return subKey === "general" || label === "其他";
}

/** 子问题展示排序：非「其他」按 count 降序，「其他」不论多少条都排最后 */
export function sortSubTagsForDisplay<T extends { count: number; label?: string | null }>(
  entries: [string, T][],
): [string, T][] {
  return [...entries].sort((a, b) => {
    const aCatchAll = isCatchAllSubTag(a[0], a[1].label);
    const bCatchAll = isCatchAllSubTag(b[0], b[1].label);
    if (aCatchAll !== bCatchAll) return aCatchAll ? 1 : -1;
    return b[1].count - a[1].count;
  });
}

export function sortSubTagRecordForDisplay<T extends { count: number; label?: string | null }>(
  subTags: Record<string, T>,
): [string, T][] {
  return sortSubTagsForDisplay(Object.entries(subTags));
}
