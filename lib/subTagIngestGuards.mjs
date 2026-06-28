/**
 * 子问题写入 taxonomy 前的确定性门禁：同父近义拒绝、跨父撞名加后缀。
 * 所有 AI 归纳 / 评论固化 / merge 路径应经此模块。
 */

import {
  buildCategoryCatalog,
  countSubTagsInReviews,
  labelsTooSimilar,
  sanitizeTagKey,
  SUBTAG_REUSE_MIN_COUNT,
} from "./promptKit.mjs";

export function ensureParentSuffix(label, parentLabel) {
  const suffix = `（${parentLabel}）`;
  if (!label || label.includes(suffix)) return label;
  return `${label}${suffix}`;
}

function findSiblingConflict(label, siblings) {
  for (const s of siblings ?? []) {
    if (!s?.label) continue;
    if (labelsTooSimilar(s.label, label)) return s;
  }
  return null;
}

function findCrossParentSimilar(label, parentKey, fullCatalog) {
  for (const cat of fullCatalog ?? []) {
    if (cat.key === parentKey) continue;
    for (const sub of cat.subcategories ?? []) {
      if (sub?.label && labelsTooSimilar(sub.label, label)) {
        return { parentKey: cat.key, parentLabel: cat.label, sub };
      }
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.parentKey
 * @param {string} opts.parentLabel
 * @param {{ key: string, label: string }[]} [opts.existingSubs]
 * @param {{ key: string, label: string }[]} [opts.incoming]
 * @param {{ key: string, label: string, subcategories?: { key: string, label: string }[] }[]} [opts.fullCatalog]
 * @param {{ log?: (msg: string) => void } | null} [opts.logger]
 */
export function filterIncomingSubcategories({
  parentKey,
  parentLabel,
  existingSubs = [],
  incoming = [],
  fullCatalog = [],
  logger = null,
}) {
  const existingKeys = new Set(
    (existingSubs ?? []).map((s) => sanitizeTagKey(s.key)).filter(Boolean),
  );
  const accepted = [];
  const rejected = [];

  const log = (msg) => {
    if (logger?.log) logger.log(msg);
  };

  for (const raw of incoming ?? []) {
    if (!raw?.key || !raw?.label) continue;
    const key = sanitizeTagKey(raw.key);
    let label = String(raw.label).trim();
    if (!key || !label) continue;

    if (existingKeys.has(key)) {
      rejected.push({ reason: "dup_key", sub: { key, label } });
      log(`[taxonomy-guard] ${parentKey} 拒绝 dup_key: ${key}(${label})`);
      continue;
    }

    const siblingPool = [...(existingSubs ?? []), ...accepted];
    const sibling = findSiblingConflict(label, siblingPool);
    if (sibling) {
      rejected.push({
        reason: "sibling_similar",
        sub: { key, label },
        existing: { key: sibling.key, label: sibling.label },
      });
      log(
        `[taxonomy-guard] ${parentKey} 拒绝 sibling_similar: proposed=${label} key=${key}，已有=${sibling.label} key=${sibling.key}`,
      );
      continue;
    }

    const cross = findCrossParentSimilar(label, parentKey, fullCatalog);
    if (cross) {
      const before = label;
      label = ensureParentSuffix(label, parentLabel);
      if (label !== before) {
        log(
          `[taxonomy-guard] ${parentKey} 跨父类消歧: ${before} → ${label}（与 ${cross.parentKey}/${cross.sub.key} 撞名）`,
        );
      }
    }

    accepted.push({ key, label });
    existingKeys.add(key);
  }

  return { accepted, rejected };
}

export function mergeSubcategoriesGuarded(existing = [], incoming = [], opts) {
  const { accepted } = filterIncomingSubcategories({
    parentKey: opts.parentKey,
    parentLabel: opts.parentLabel,
    existingSubs: existing,
    incoming,
    fullCatalog: opts.fullCatalog ?? [],
    logger: opts.logger ?? null,
  });
  const byKey = new Map();
  for (const s of [...existing, ...accepted]) {
    if (!s?.key || !s?.label) continue;
    const key = sanitizeTagKey(s.key);
    if (!byKey.has(key)) byKey.set(key, { key, label: String(s.label).trim() });
  }
  return [...byKey.values()];
}

/** 校准后合并：保留 base subs，仅对新增 key 过门禁；已有 key 采用 proposed 的 label（校准可能改名） */
export function applyGuardedSubMerge(baseSubs, proposed, opts) {
  const baseKeys = new Set((baseSubs ?? []).map((s) => sanitizeTagKey(s.key)));
  const incoming = (proposed ?? []).filter((s) => s?.key && !baseKeys.has(sanitizeTagKey(s.key)));
  let merged = mergeSubcategoriesGuarded(baseSubs ?? [], incoming, opts);
  const byKey = new Map(merged.map((s) => [sanitizeTagKey(s.key), s]));
  for (const p of proposed ?? []) {
    const k = sanitizeTagKey(p.key);
    if (!k || !baseKeys.has(k) || !byKey.has(k)) continue;
    byKey.set(k, { key: k, label: String(p.label).trim() });
  }
  return [...byKey.values()];
}

/** bootstrap / 修订 AI 返回整份 taxonomy 时：各父类内去 sibling 近义 + 跨父后缀 */
export function guardTaxonomySubcategories(taxonomy, { logger = null } = {}) {
  return (taxonomy ?? []).map((c) => {
    const { accepted } = filterIncomingSubcategories({
      parentKey: c.key,
      parentLabel: c.label,
      existingSubs: [],
      incoming: c.subcategories ?? [],
      fullCatalog: taxonomy,
      logger,
    });
    return { ...c, subcategories: accepted };
  });
}

export function catalogForSubTagGuards(seedCategories, universalSubcategories = {}) {
  return buildCategoryCatalog(seedCategories, universalSubcategories);
}

/**
 * 把评论里已稳定出现的 subTag 合并进 seed_categories（只追加，不删改已有项）。
 * 追加前过 ingest 门禁。
 */
export function mergeObservedSubTagsIntoTaxonomy(
  seedCategories,
  classifiedReviews,
  minCount = SUBTAG_REUSE_MIN_COUNT,
) {
  const counts = countSubTagsInReviews(classifiedReviews);
  const byParentKey = new Map((seedCategories ?? []).map((c) => [c.key, c]));
  const fullCatalog = catalogForSubTagGuards([...byParentKey.values()]);
  let added = 0;

  for (const [parentKey, subs] of counts) {
    const cat = byParentKey.get(parentKey);
    if (!cat) continue;
    const existing = [...(cat.subcategories ?? [])];
    const incoming = [];
    const existingKeys = new Set(existing.map((s) => sanitizeTagKey(s.key)));

    for (const [subKey, { label, count }] of subs) {
      if (count < minCount || existingKeys.has(subKey)) continue;
      incoming.push({ key: subKey, label });
    }

    if (!incoming.length) continue;

    const { accepted } = filterIncomingSubcategories({
      parentKey,
      parentLabel: cat.label,
      existingSubs: existing,
      incoming,
      fullCatalog,
    });
    if (!accepted.length) continue;

    cat.subcategories = [...existing, ...accepted];
    added += accepted.length;
  }

  return { taxonomy: [...byParentKey.values()], added };
}
