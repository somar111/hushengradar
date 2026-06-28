// taxonomy 全生命周期的"大脑"——但判断与措辞交给 AI，本文件只做机械事：
//   1. 从实时标签分布收集信号（事实，不含判断）
//   2. 机械门槛决定要不要惊动 AI（避免每轮空跑，纯运营 scaffolding）
//   3. 把 AI 产出的修订提案拆成「确定性 remap」与「需重读 reclassify」
//   4. 确定性 remap 直接改写 ai_tags；reclassify 写进待确认队列（或 policy 自动放行）
//   5. 写库前 ensureTaxonomyMinSubs 补足母类 sub（≥2 才强制 subKey / Top chip）；expandReclassifyAffectedKeys 扩充受影响 key
//   6. 版本化快照，便于审计/回滚
//
// 所有"内容判断"（是否该改、改成什么、新 label/key）来自 buildTaxonomyRevisionPrompt 的模型输出；
// 本文件不含任何 App 专属的硬编码类目，对任何 App 通用。
//
// orchestrator 通过依赖注入拿到 supabase 与 callModel，保证手动 CLI 与每日 cron 走同一条代码路径。

import {
  UNIVERSAL_CATEGORIES,
  buildTagCountsFromReviews,
  buildDesignedSubKeysByParent,
  buildTaxonomyPrompt,
  buildTaxonomyRevisionPrompt,
  countDesignedMeaningfulSubs,
  findLowHitSubKeys,
  findCrossCategorySubOverlaps,
  disambiguateCrossCategorySubLabels,
  labelsTooSimilar,
  LOW_SUB_RECLASSIFY_MAX_COUNT,
  MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN,
  sanitizeTagKey,
  SUBTAG_REUSE_EXCLUDE_KEYS,
  SUBTAG_REUSE_MIN_COUNT,
  aiTagKeysFromTags,
} from "./promptKit.mjs";
import { guardTaxonomySubcategories } from "./subTagIngestGuards.mjs";

const UNIVERSAL_KEYS = new Set(UNIVERSAL_CATEGORIES.map((c) => c.key));

// 运营旋钮的默认值（非判断、可按 App 在 apps.taxonomy_meta.policy 覆盖）。
// 这些只是"要不要惊动 AI / 多久一次 / 破坏性是否自动"的工程门槛，不是"分类该长什么样"的判断。
export const DEFAULT_TAXONOMY_POLICY = {
  autoBuildMinReviews: 150, // 还没有成形 taxonomy 时，攒够多少条已分类评论才自动 bootstrap
  reviseCooldownDays: 7, // 两次自动修订的最小间隔（天）
  autoReclassify: false, // 全量（scope=full）破坏性重分类是否自动放行；默认否
  autoReclassifyIncremental: false, // 增量（scope=incremental）破坏性重分类是否自动放行；默认保守
  orphanTriggerCount: 8, // 孤儿顶层标签累计命中达到多少，才考虑修订
  fragmentTriggerCount: 3, // 近义/过碎子问题组达到多少，才考虑修订
  vagueShareTrigger: 0.2, // vague_complaint 占比超过多少，疑似体系缺类目
  bootstrapSampleSize: 250, // bootstrap 时喂给 AI 的评论样本量
  revisionEvidencePerSignal: 6, // 每个信号附带的样本条数（控制 prompt 体积）
  // —— 防早期噪声传染（与子问题复用池"本轮新造不立刻进池"同一原则的 taxonomy 层等价物）——
  orphanMinCount: 5, // 孤儿顶层标签命中达到此数才算"信号"，过滤偶发噪声（A）
  fragmentMinCount: 6, // 近义子问题组的合计命中达到此数才算"碎片"，忽略零星变体（A）
  misrouteTriggerCount: 3, // P2：跨类 misroute 子问题组达到多少才触发修订
  misrouteMinCount: 3, // 单条 misroute 信号最少命中量
  minEvidenceSpanDays: 3, // 候选的支撑评论必须跨 ≥ 此天数（按 review_date），证明不是单批噪声而是沉淀（C）
  overbroadShareTrigger: 0.3, // 某 sub 占父类命中比例超过此值，疑似过宽桶
  overbroadMinCount: 20, // 过宽 sub 最少命中量
  overbroadTriggerCount: 1, // 过宽 sub 信号达到多少才触发修订
  crossCategoryOverlapTriggerCount: 1, // 跨顶层近义/同主题 sub 达到多少组才触发修订
};

export function getTaxonomyPolicy(app) {
  return { ...DEFAULT_TAXONOMY_POLICY, ...(app?.taxonomy_meta?.policy ?? {}) };
}

/** 是否已是"成形 taxonomy"（有子问题），而不是 add-app 给的扁平起步种子 */
export function hasDesignedTaxonomy(seedCategories) {
  return (seedCategories ?? []).some(
    (c) => Array.isArray(c?.subcategories) && c.subcategories.length > 0
  );
}

// ── 1. 信号收集（纯函数，只数数，不做任何判断）────────────────────────────────

/** 均匀抽样：按步长覆盖整个分布，比纯随机稳定 */
export function spread(arr, n) {
  if (arr.length <= n) return [...arr];
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

function parseMs(d) {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}
function spanDaysOf(min, max) {
  return min == null || max == null ? 0 : (max - min) / 86400000;
}

/**
 * 从已分类评论收集 taxonomy 健康信号。reviews 形如 [{ ai_tags: [...], review_date }]。
 *
 * 防早期噪声传染（与"本轮新造 subKey 不立刻进复用池"同源的 taxonomy 层护栏）：
 *   - A 量地板：孤儿(orphanMinCount)、碎片组(fragmentMinCount) 必须达到一定命中量才算信号，过滤偶发噪声；
 *     子问题固化沿用 ≥minStableCount。
 *   - C 沉淀隔离：候选的支撑评论必须按 review_date 跨 ≥minEvidenceSpanDays 天，
 *     证明它是跨时间沉淀下来的真实模式，而不是某一批（尤其早期/单次重分类）里集中冒出来的噪声。
 * 未过门槛的候选被"隔离"——既不计入触发，也不会出现在喂给 AI 的信号里。
 */
export function collectTaxonomySignals(seedCategories, reviews, {
  minStableCount = SUBTAG_REUSE_MIN_COUNT,
  orphanMinCount = DEFAULT_TAXONOMY_POLICY.orphanMinCount,
  fragmentMinCount = DEFAULT_TAXONOMY_POLICY.fragmentMinCount,
  minEvidenceSpanDays = DEFAULT_TAXONOMY_POLICY.minEvidenceSpanDays,
  misrouteMinCount = DEFAULT_TAXONOMY_POLICY.misrouteMinCount,
} = {}) {
  const taxonomyKeys = new Set((seedCategories ?? []).map((c) => c.key));
  const baselineKeys = new Set([...UNIVERSAL_KEYS, ...taxonomyKeys]);
  const totalClassified = reviews.length;

  const categoryCounts = buildTagCountsFromReviews(reviews);

  // 单遍：孤儿顶层标签信息 + 每个（父类 > 原始 subKey）的命中量与时间跨度。
  // 注意 categoryCounts 的 subTags 已被 mergeSimilarSubTags 合并，不能拿它找碎片/固化——
  // 这里用未合并的原始 subKey 计数，并顺带记录 review_date 的 min/max 以算沉淀跨度。
  const orphanMap = new Map();
  const subMap = new Map(); // parentKey -> Map<subKey, { label, count, min, max }>
  for (const r of reviews) {
    const t = parseMs(r.review_date);
    for (const tag of r.ai_tags ?? []) {
      if (!tag?.key) continue;
      if (!baselineKeys.has(tag.key)) {
        const e = orphanMap.get(tag.key) ?? { key: tag.key, label: tag.label || tag.key, count: 0, samples: [], min: null, max: null };
        e.count++;
        if (e.samples.length < 6 && tag.evidence) e.samples.push(tag.evidence);
        if (t != null) { e.min = e.min == null ? t : Math.min(e.min, t); e.max = e.max == null ? t : Math.max(e.max, t); }
        orphanMap.set(tag.key, e);
      }
      if (tag.subKey && !SUBTAG_REUSE_EXCLUDE_KEYS.has(tag.subKey)) {
        const byParent = subMap.get(tag.key) ?? new Map();
        const s = byParent.get(tag.subKey) ?? { label: tag.subLabel || tag.subKey, count: 0, min: null, max: null };
        s.count++;
        if (tag.subLabel) s.label = tag.subLabel;
        if (t != null) { s.min = s.min == null ? t : Math.min(s.min, t); s.max = s.max == null ? t : Math.max(s.max, t); }
        byParent.set(tag.subKey, s);
        subMap.set(tag.key, byParent);
      }
    }
  }

  // 孤儿：过 量地板(A) + 沉淀跨度(C)
  const orphanTopTags = [...orphanMap.values()]
    .filter((o) => o.count >= orphanMinCount && spanDaysOf(o.min, o.max) >= minEvidenceSpanDays)
    .map((o) => ({ key: o.key, label: o.label, count: o.count, samples: o.samples, spanDays: Math.round(spanDaysOf(o.min, o.max)) }))
    .sort((a, b) => b.count - a.count);

  // 过碎/近义子问题：同一父类下 label 互相近义却用了不同 subKey；只保留组内合计达到 fragmentMinCount 的
  const fragmentedSubs = [];
  for (const [parentKey, byParent] of subMap) {
    const subs = [...byParent.entries()].map(([key, v]) => ({ key, label: v.label, count: v.count }));
    const used = new Set();
    for (let i = 0; i < subs.length; i++) {
      if (used.has(subs[i].key)) continue;
      const group = [subs[i]];
      for (let j = i + 1; j < subs.length; j++) {
        if (used.has(subs[j].key)) continue;
        if (labelsTooSimilar(subs[i].label, subs[j].label)) {
          group.push(subs[j]);
          used.add(subs[j].key);
        }
      }
      if (group.length > 1) {
        used.add(subs[i].key);
        const count = group.reduce((n, g) => n + g.count, 0);
        if (count >= fragmentMinCount) {
          fragmentedSubs.push({ parentKey, labels: group.map((g) => g.label), keys: group.map((g) => g.key), count });
        }
      }
    }
  }

  // 已稳定出现却还没进 taxonomy 子问题清单的 subKey（过 ≥minStableCount 量 + 沉淀跨度 才算待固化）
  const designedSubsByParent = new Map(
    (seedCategories ?? []).map((c) => [c.key, new Set((c.subcategories ?? []).map((s) => sanitizeTagKey(s.key)))])
  );
  const stableUnpromotedSubs = [];
  for (const [parentKey, byParent] of subMap) {
    if (!taxonomyKeys.has(parentKey)) continue; // 孤儿父类的子问题归在 orphan 信号里
    const designed = designedSubsByParent.get(parentKey) ?? new Set();
    for (const [subKey, v] of byParent) {
      if (v.count >= minStableCount && spanDaysOf(v.min, v.max) >= minEvidenceSpanDays && !designed.has(subKey)) {
        stableUnpromotedSubs.push({ parentKey, subKey, label: v.label, count: v.count, spanDays: Math.round(spanDaysOf(v.min, v.max)) });
      }
    }
  }
  stableUnpromotedSubs.sort((a, b) => b.count - a.count);

  // taxonomy 里列了但一条都没命中的类目（疑似冗余；这是"缺失"信号，与噪声无关，不设量门槛）
  const deadCategories = (seedCategories ?? [])
    .filter((c) => !(categoryCounts[c.key]?.count > 0))
    .map((c) => ({ key: c.key, label: c.label }));

  const vagueCount = categoryCounts.vague_complaint?.count ?? 0;
  const vagueShare = totalClassified ? vagueCount / totalClassified : 0;

  // P2：跨类 misroute——App 专属母类下，子问题语义像 feature_request 的稳定命中
  const misrouteSubs = collectMisrouteSignals(seedCategories, reviews, {
    minCount: misrouteMinCount ?? DEFAULT_TAXONOMY_POLICY.misrouteMinCount,
    minEvidenceSpanDays,
  });

  const overbroadSubs = collectOverbroadSubSignals(categoryCounts, reviews, {
    overbroadShareTrigger: DEFAULT_TAXONOMY_POLICY.overbroadShareTrigger,
    overbroadMinCount: DEFAULT_TAXONOMY_POLICY.overbroadMinCount,
    minEvidenceSpanDays,
  });

  const crossCategorySubOverlaps = findCrossCategorySubOverlaps(seedCategories);

  return {
    totalClassified,
    categoryCounts,
    orphanTopTags,
    fragmentedSubs,
    stableUnpromotedSubs,
    deadCategories,
    vagueShare,
    misrouteSubs,
    overbroadSubs,
    crossCategorySubOverlaps,
  };
}

/** P2：从已分类评论收集「可能归错 universal 类」的子问题信号（机械规则，判断交给 revision AI） */
export function collectMisrouteSignals(seedCategories, reviews, { minCount = 3, minEvidenceSpanDays = 3 } = {}) {
  const taxonomyKeys = new Set((seedCategories ?? []).map((c) => c.key));
  const frIntent = UNIVERSAL_CATEGORIES.find((c) => c.key === "feature_request")?.intent ?? "";
  const byKey = new Map(); // `${parentKey}\0${subKey}` -> { parentKey, subKey, label, count, samples, min, max }

  for (const r of reviews) {
    const tms = parseMs(r.review_date);
    for (const tag of r.ai_tags ?? []) {
      if (!tag?.key || !tag.subKey || SUBTAG_REUSE_EXCLUDE_KEYS.has(tag.subKey)) continue;
      if (!taxonomyKeys.has(tag.key)) continue; // 只审 App 专属母类
      if (tag.key === "feature_request") continue;

      const text = `${tag.subLabel ?? ""} ${tag.evidence ?? ""} ${tag.subKey ?? ""}`;
      if (!REQUEST_LIKE_MISROUTE.test(text)) continue;

      const id = `${tag.key}\0${tag.subKey}`;
      const e = byKey.get(id) ?? {
        parentKey: tag.key,
        parentLabel: tag.label,
        subKey: tag.subKey,
        subLabel: tag.subLabel || tag.subKey,
        suggestedTargetKey: "feature_request",
        suggestedTargetLabel: "功能请求",
        count: 0,
        samples: [],
        min: null,
        max: null,
      };
      e.count++;
      if (e.samples.length < 6 && tag.evidence) e.samples.push(tag.evidence);
      if (tms != null) {
        e.min = e.min == null ? tms : Math.min(e.min, tms);
        e.max = e.max == null ? tms : Math.max(e.max, tms);
      }
      byKey.set(id, e);
    }
  }

  return [...byKey.values()]
    .filter((e) => e.count >= minCount && spanDaysOf(e.min, e.max) >= minEvidenceSpanDays)
    .map((e) => ({
      ...e,
      spanDays: Math.round(spanDaysOf(e.min, e.max)),
      reasonHint: `子问题语义接近「${frIntent.slice(0, 40)}…」却落在 ${e.parentKey} 下`,
    }))
    .sort((a, b) => b.count - a.count);
}

const REQUEST_LIKE_MISROUTE = /请求|希望|想要|请加|添加|增加|缺少|缺失|应该有|wish|request|new hero|new map|more hero/i;

/** P2：某 sub 占父类比例过高且 evidence 主题分散 → 疑似过宽桶 */
export function collectOverbroadSubSignals(categoryCounts, reviews, {
  overbroadShareTrigger = DEFAULT_TAXONOMY_POLICY.overbroadShareTrigger,
  overbroadMinCount = DEFAULT_TAXONOMY_POLICY.overbroadMinCount,
  minEvidenceSpanDays = DEFAULT_TAXONOMY_POLICY.minEvidenceSpanDays,
} = {}) {
  const byKey = new Map(); // `${parentKey}\0${subKey}` -> { parentKey, subKey, label, count, samples, min, max }

  for (const r of reviews) {
    const tms = parseMs(r.review_date);
    for (const tag of r.ai_tags ?? []) {
      if (!tag?.key || !tag.subKey || SUBTAG_REUSE_EXCLUDE_KEYS.has(tag.subKey)) continue;
      const id = `${tag.key}\0${tag.subKey}`;
      const e = byKey.get(id) ?? {
        parentKey: tag.key,
        parentLabel: tag.label,
        subKey: tag.subKey,
        subLabel: tag.subLabel || tag.subKey,
        count: 0,
        samples: [],
        min: null,
        max: null,
      };
      e.count++;
      if (e.samples.length < 8 && tag.evidence) e.samples.push(tag.evidence);
      if (tms != null) {
        e.min = e.min == null ? tms : Math.min(e.min, tms);
        e.max = e.max == null ? tms : Math.max(e.max, tms);
      }
      byKey.set(id, e);
    }
  }

  return [...byKey.values()]
    .filter((e) => {
      const parentCount = categoryCounts[e.parentKey]?.count ?? 0;
      if (e.count < overbroadMinCount || parentCount < overbroadMinCount) return false;
      if (e.count / parentCount < overbroadShareTrigger) return false;
      if (spanDaysOf(e.min, e.max) < minEvidenceSpanDays) return false;
      // evidence 主题分散：样本首词/前缀去重后 ≥3 种
      const prefixes = new Set(
        e.samples.map((s) => String(s).replace(/\s+/g, " ").trim().slice(0, 12)).filter(Boolean),
      );
      return prefixes.size >= 3;
    })
    .map((e) => {
      const parentCount = categoryCounts[e.parentKey]?.count ?? 0;
      return {
        ...e,
        parentCount,
        share: parentCount ? e.count / parentCount : 0,
        spanDays: Math.round(spanDaysOf(e.min, e.max)),
        reasonHint: `占父类 ${(100 * e.count / parentCount).toFixed(0)}% 且 evidence 主题分散，疑似过宽 sub`,
      };
    })
    .sort((a, b) => b.share - a.share);
}

// ── 2. 决策门槛（纯函数，机械 scaffolding；真正"要不要改"仍由 AI verdict 决定）──────────

/**
 * @returns {{ action: 'none'|'bootstrap'|'revise', reason: string }}
 */
export function decideTaxonomyAction(app, signals, { now = new Date(), force = false } = {}) {
  const designed = hasDesignedTaxonomy(app.seed_categories);

  if (force) {
    return designed
      ? { action: "revise", reason: "手动强制：重新评估现有 taxonomy" }
      : { action: "bootstrap", reason: "手动强制：从样本设计初始 taxonomy" };
  }

  const policy = getTaxonomyPolicy(app);

  if (!designed) {
    if (signals.totalClassified >= policy.autoBuildMinReviews) {
      return { action: "bootstrap", reason: `已分类 ${signals.totalClassified} 条 ≥ ${policy.autoBuildMinReviews}，自动设计初始 taxonomy` };
    }
    return { action: "none", reason: `已分类 ${signals.totalClassified} 条 < ${policy.autoBuildMinReviews}，样本不足，暂不 bootstrap` };
  }

  // 冷却：距上次修订不足 reviseCooldownDays 天则不主动惊动 AI
  const revisedAt = app.taxonomy_meta?.revisedAt ? new Date(app.taxonomy_meta.revisedAt) : null;
  if (revisedAt) {
    const days = (now - revisedAt) / 86400000;
    if (days < policy.reviseCooldownDays) {
      return { action: "none", reason: `距上次修订 ${days.toFixed(1)} 天 < 冷却 ${policy.reviseCooldownDays} 天，跳过` };
    }
  }

  const triggers = [];
  const orphanTotal = signals.orphanTopTags.reduce((n, o) => n + o.count, 0);
  if (orphanTotal >= policy.orphanTriggerCount) triggers.push(`孤儿标签命中 ${orphanTotal}≥${policy.orphanTriggerCount}`);
  if (signals.fragmentedSubs.length >= policy.fragmentTriggerCount) triggers.push(`近义子问题 ${signals.fragmentedSubs.length} 组≥${policy.fragmentTriggerCount}`);
  if (signals.vagueShare >= policy.vagueShareTrigger) triggers.push(`vague 占比 ${(signals.vagueShare * 100).toFixed(0)}%≥${(policy.vagueShareTrigger * 100).toFixed(0)}%`);
  if (signals.stableUnpromotedSubs.length > 0) triggers.push(`待固化子问题 ${signals.stableUnpromotedSubs.length} 个`);
  if (signals.deadCategories.length > 0) triggers.push(`零命中类目 ${signals.deadCategories.length} 个`);
  if (signals.misrouteSubs?.length >= policy.misrouteTriggerCount) {
    triggers.push(`跨类 misroute 信号 ${signals.misrouteSubs.length} 组≥${policy.misrouteTriggerCount}`);
  }
  if (signals.overbroadSubs?.length >= policy.overbroadTriggerCount) {
    triggers.push(`过宽 sub 信号 ${signals.overbroadSubs.length} 个≥${policy.overbroadTriggerCount}`);
  }
  if (signals.crossCategorySubOverlaps?.length >= policy.crossCategoryOverlapTriggerCount) {
    triggers.push(`跨类 sub 重叠 ${signals.crossCategorySubOverlaps.length} 组≥${policy.crossCategoryOverlapTriggerCount}`);
  }

  if (triggers.length) {
    return { action: "revise", reason: `信号触发：${triggers.join("；")}` };
  }
  return { action: "none", reason: "无明显漂移信号，taxonomy 视为稳定" };
}

// ── 3. 把信号渲染成喂给修订 prompt 的 user 文本 ─────────────────────────────────

export function buildRevisionUserPayload(app, signals, { evidencePerSignal = 6 } = {}) {
  const lines = [];
  lines.push(`这款 App 的背景信息：${app.context || "（无）"}`);
  lines.push(`已分类评论总数：${signals.totalClassified}`);

  lines.push("\n当前分类体系及真实命中量：");
  for (const c of app.seed_categories ?? []) {
    const cc = signals.categoryCounts[c.key];
    const intent = c.intent ? `　intent：${c.intent}` : "";
    const subs = (c.subcategories ?? []).map((s) => {
      const n = cc?.subTags?.[sanitizeTagKey(s.key)]?.count ?? 0;
      return `${s.key}(${s.label}):${n}`;
    });
    lines.push(`- ${c.key}(${c.label}) 命中${cc?.count ?? 0}${intent}　子：${subs.join("、") || "（无）"}`);
  }

  if (signals.misrouteSubs?.length) {
    lines.push("\n跨类 misroute 信号（App 专属母类下、语义像 feature_request 的稳定子问题）：");
    for (const m of signals.misrouteSubs.slice(0, 20)) {
      lines.push(
        `- ${m.parentKey} > ${m.subKey}(${m.subLabel})×${m.count}（跨${m.spanDays}天）→ 建议审视是否应归 ${m.suggestedTargetKey}　例：${m.samples.slice(0, 4).join(" / ") || "（无）"}`
      );
    }
  }

  if (signals.overbroadSubs?.length) {
    lines.push("\n过宽 sub 信号（占父类比例高且 evidence 主题分散）：");
    for (const o of signals.overbroadSubs.slice(0, 15)) {
      lines.push(
        `- ${o.parentKey} > ${o.subKey}(${o.subLabel})×${o.count}（占父类 ${(o.share * 100).toFixed(0)}%，跨${o.spanDays}天）　例：${o.samples.slice(0, 4).join(" / ") || "（无）"}`
      );
    }
  }

  if (signals.crossCategorySubOverlaps?.length) {
    lines.push("\n跨顶层 sub 重叠（同主题或近义子问题出现在不同母类下，须合并到 intent 更匹配的一类）：");
    for (const o of signals.crossCategorySubOverlaps.slice(0, 20)) {
      lines.push(
        `- ${o.parentA}(${o.parentALabel}) > ${o.subA}(${o.subALabel}) ↔ ${o.parentB}(${o.parentBLabel}) > ${o.subB}(${o.subBLabel})　${o.reason ?? ""}`
      );
    }
  }

  lines.push("\n（以下信号都已过『最小命中量 + 跨多天沉淀』的噪声门槛，是相对稳定的模式，不是单批偶发噪声。）");
  if (signals.orphanTopTags.length) {
    lines.push("\n孤儿顶层标签（模型临时造、还没进体系）：");
    for (const o of signals.orphanTopTags) {
      lines.push(`- ${o.key}(${o.label})×${o.count}（跨${o.spanDays}天）　例：${o.samples.slice(0, evidencePerSignal).join(" / ") || "（无）"}`);
    }
  }
  if (signals.fragmentedSubs.length) {
    lines.push("\n疑似近义/过碎的子问题组（同一父类下）：");
    for (const f of signals.fragmentedSubs) {
      lines.push(`- 父类 ${f.parentKey} 下：${f.keys.map((k, i) => `${k}(${f.labels[i]})`).join("、")} 合计 ${f.count}`);
    }
  }
  if (signals.stableUnpromotedSubs.length) {
    lines.push("\n已稳定出现但还没进体系的子问题：");
    for (const s of signals.stableUnpromotedSubs.slice(0, 20)) {
      lines.push(`- ${s.parentKey} > ${s.subKey}(${s.label})×${s.count}（跨${s.spanDays}天）`);
    }
  }
  if (signals.deadCategories.length) {
    lines.push(`\n零命中类目（疑似冗余，可考虑删除/合并）：${signals.deadCategories.map((d) => `${d.key}(${d.label})`).join("、")}`);
  }
  lines.push(`\nvague_complaint（意义不明纯抱怨）占比：${(signals.vagueShare * 100).toFixed(1)}%`);

  return lines.join("\n");
}

// ── 4. 校验 + diff 拆分 + 确定性 remap（纯函数）────────────────────────────────

/** 把 AI 返回的 taxonomy 清洗成稳定结构，剔除系统通用类、去重、保证形状 */
export function sanitizeTaxonomy(rawCategories) {
  if (!Array.isArray(rawCategories)) return [];
  const seen = new Set();
  const out = [];
  for (const c of rawCategories) {
    if (!c?.key || !c?.label) continue;
    const key = sanitizeTagKey(c.key);
    if (UNIVERSAL_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    const subSeen = new Set();
    const subcategories = [];
    for (const s of c.subcategories ?? []) {
      if (!s?.key || !s?.label) continue;
      const sk = sanitizeTagKey(s.key);
      if (subSeen.has(sk)) continue;
      subSeen.add(sk);
      subcategories.push({ key: sk, label: String(s.label).trim() });
    }
    out.push({
      key,
      label: String(c.label).trim(),
      intent: c.intent ? String(c.intent).trim() : undefined,
      subcategories,
    });
  }
  return disambiguateCrossCategorySubLabels(guardTaxonomySubcategories(out));
}

/** taxonomy subLabel 消歧后，生成确定性 remap 以同步历史 ai_tags */
export function buildSubLabelRemapsFromTaxonomyDiff(oldCategories, newCategories) {
  const oldLabels = new Map();
  for (const c of oldCategories ?? []) {
    for (const s of c.subcategories ?? []) {
      oldLabels.set(`${c.key}\0${s.key}`, s.label);
    }
  }
  const remaps = [];
  for (const c of newCategories ?? []) {
    for (const s of c.subcategories ?? []) {
      const id = `${c.key}\0${s.key}`;
      const prev = oldLabels.get(id);
      if (prev && prev !== s.label) {
        remaps.push({
          match: { key: c.key, subKey: s.key },
          set: { subLabel: s.label },
          reason: "cross-category sub label disambiguation",
        });
      }
    }
  }
  return remaps;
}

/**
 * 把修订提案里的 changes 拆成两类：
 *   - remaps：确定性映射条目（来自 consequence==="remap" 的变更），可直接改写 ai_tags
 *   - reclassify：需重读的变更，附带受影响的现有顶层 key 集合
 */
export function partitionChanges(changes) {
  const remaps = [];
  const reclassifyChanges = [];
  const affectedKeys = new Set();
  for (const ch of changes ?? []) {
    if (ch?.consequence === "remap" && Array.isArray(ch.remap)) {
      for (const m of ch.remap) {
        if (m?.match?.key && m?.set && typeof m.set === "object") {
          remaps.push({
            match: { key: sanitizeTagKey(m.match.key), subKey: m.match.subKey ? sanitizeTagKey(m.match.subKey) : null },
            set: normalizeRemapSet(m.set),
            reason: ch.reason ?? null,
            type: ch.type ?? null,
          });
        }
      }
    } else if (ch?.consequence === "reclassify") {
      reclassifyChanges.push(ch);
      for (const k of ch.affectedKeys ?? []) affectedKeys.add(sanitizeTagKey(k));
    }
  }
  return { remaps, reclassifyChanges, affectedKeys: [...affectedKeys] };
}

/**
 * 扩充 reclassify 受影响顶层 key：新固化孤儿类、母类 sub 从不足增至达标，须重读已有命中。
 * @param {object} opts
 * @param {object[]} opts.oldCategories 修订前 seed_categories
 * @param {object[]} opts.taxonomy 修订后完整 taxonomy
 * @param {string[]} opts.partitionedKeys partitionChanges 汇总的 affectedKeys
 * @param {{ orphanTopTags?: { key: string }[] }} [opts.signals]
 */
export function expandReclassifyAffectedKeys({ oldCategories, taxonomy, partitionedKeys, signals }) {
  const keys = new Set(partitionedKeys ?? []);
  const oldByKey = new Map((oldCategories ?? []).map((c) => [c.key, c]));
  const taxonomyKeySet = new Set((taxonomy ?? []).map((c) => c.key));

  for (const c of taxonomy ?? []) {
    const old = oldByKey.get(c.key);
    const newSubs = countDesignedMeaningfulSubs(c.subcategories);
    if (!old) {
      keys.add(c.key);
      continue;
    }
    const oldSubs = countDesignedMeaningfulSubs(old.subcategories);
    if (oldSubs < MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN && newSubs >= MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN) {
      keys.add(c.key);
    }
  }

  for (const o of signals?.orphanTopTags ?? []) {
    if (!oldByKey.has(o.key) && taxonomyKeySet.has(o.key)) keys.add(o.key);
  }

  return [...keys];
}

function normalizeRemapSet(set) {
  const out = {};
  if (set.key) out.key = sanitizeTagKey(set.key);
  if (set.label) out.label = String(set.label).trim();
  if (set.subKey !== undefined) out.subKey = set.subKey ? sanitizeTagKey(set.subKey) : null;
  if (set.subLabel !== undefined) out.subLabel = set.subLabel ? String(set.subLabel).trim() : null;
  return out;
}

/** 一个 tag 是否命中某条 remap 的 match（subKey 缺省=只按 key 匹配） */
function tagMatchesRemap(tag, match) {
  if (tag.key !== match.key) return false;
  if (match.subKey == null) return true;
  return (tag.subKey ?? null) === match.subKey;
}

/**
 * 对单条评论的 ai_tags 应用 remap（纯函数）：命中 match 的 tag 套用 set，再按 (key,subKey) 去重。
 * @returns {{ tags: object[], changed: boolean }}
 */
export function applyRemapToTags(aiTags, remaps) {
  let changed = false;
  const mapped = (aiTags ?? []).map((t) => {
    let next = { ...t };
    for (const r of remaps) {
      if (tagMatchesRemap(next, r.match)) {
        const before = JSON.stringify(next);
        next = { ...next, ...r.set };
        if (next.subKey && !next.subLabel) next.subLabel = next.subLabel ?? null;
        if (JSON.stringify(next) !== before) changed = true;
      }
    }
    return next;
  });
  const seen = new Set();
  const tags = mapped.filter((t) => {
    const id = `${t.key}\0${t.subKey ?? ""}`;
    if (seen.has(id)) return (changed = true), false;
    seen.add(id);
    return true;
  });
  return { tags, changed };
}

/** remap 涉及的所有源顶层 key（用来查需要改写的评论集合） */
export function remapSourceKeys(remaps) {
  return [...new Set(remaps.map((r) => r.match.key))];
}

// ── 5. orchestrator：手动 CLI 与每日 cron 共用的唯一入口 ────────────────────────
//
// 依赖注入（不在本文件里碰具体的 supabase 实例或 DeepSeek fetch，保持可测/可换模型）：
//   - supabase：已建好的 client
//   - callModel(systemPrompt, userPrompt) => Promise<解析后的 JSON 对象>
//   - logger：可选，默认 console
// options：{ force?: bool, dryRun?: bool, classifiedReviews?: [{ai_tags}] 预加载 }
//
// 返回 report：{ action, reason, verdict?, version?, remapped?, pendingReclassify?, taxonomy? }
// 落地策略（与产品约定一致）：
//   - 非破坏性（remap）→ 自动应用 + 版本化快照
//   - 破坏性（reclassify）→ 写 apps.pending_reclassify，等人工确认；policy.autoReclassify 时才自动重置受影响评论

async function fetchAllRows(query, pageSize = 1000) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

export async function runTaxonomyStage({ supabase, app, callModel, logger = console, options = {} }) {
  const { force = false, dryRun = false } = options;
  const policy = getTaxonomyPolicy(app);

  // 信号需要 ai_tags + review_date（后者用于沉淀跨度判断）；调用方（cron）常已加载，可注入复用
  const classifiedReviews = options.classifiedReviews
    ?? await fetchAllRows(
      supabase.from("reviews").select("ai_tags, review_date").eq("app_id", app.id).not("ai_classified_at", "is", null)
    );

  const signals = collectTaxonomySignals(app.seed_categories ?? [], classifiedReviews, {
    orphanMinCount: policy.orphanMinCount,
    fragmentMinCount: policy.fragmentMinCount,
    minEvidenceSpanDays: policy.minEvidenceSpanDays,
    misrouteMinCount: policy.misrouteMinCount,
  });
  const decision = decideTaxonomyAction(app, signals, { force });
  logger.log(`[taxonomy] 决策=${decision.action}（${decision.reason}）`);

  if (decision.action === "none") {
    return { action: "none", reason: decision.reason };
  }

  if (decision.action === "bootstrap") {
    return runBootstrap({ supabase, app, callModel, logger, dryRun });
  }

  return runRevision({ supabase, app, callModel, logger, dryRun, signals, policy });
}

async function runBootstrap({ supabase, app, callModel, logger, dryRun }) {
  const policy = getTaxonomyPolicy(app);
  const rows = await fetchAllRows(
    supabase.from("reviews").select("content, rating").eq("app_id", app.id)
  );
  const problems = rows.filter((r) => (r.rating ?? 5) <= 3 && r.content?.trim());
  const others = rows.filter((r) => (r.rating ?? 5) > 3 && r.content?.trim());
  const n = policy.bootstrapSampleSize;
  const sample = [...spread(problems, n), ...spread(others, Math.max(0, n - problems.length))].slice(0, n);
  logger.log(`[taxonomy] bootstrap：总评论 ${rows.length}，抽样 ${sample.length} 条喂给 AI 设计体系`);

  const sampleText = sample
    .map((r, i) => `${i + 1}. [${r.rating}★] ${r.content.replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
  const userPrompt = `这款App的背景信息：${app.context || "（无）"}\n\n真实用户评论样本：\n${sampleText}`;
  const parsed = await callModel(buildTaxonomyPrompt(), userPrompt);
  let taxonomy = sanitizeTaxonomy(parsed?.categories);
  if (!taxonomy.length) throw new Error("AI 返回的 taxonomy 为空");

  const { calibrateDesignedTaxonomy } = await import("./taxonomyEnrich.mjs");
  taxonomy = await calibrateDesignedTaxonomy({
    callModel,
    logger,
    proposedCategories: taxonomy,
    appContext: app.context,
  });
  if (!taxonomy.length) throw new Error("P0.5 校准后 taxonomy 为空");

  const { ensureTaxonomyMinSubs } = await import("./taxonomyEnrich.mjs");
  taxonomy = await ensureTaxonomyMinSubs({
    taxonomy,
    signals: { orphanTopTags: [] },
    app,
    callModel,
    logger,
  });

  const version = (app.taxonomy_meta?.version ?? 0) + 1;
  const nowIso = new Date().toISOString();
  const meta = { ...(app.taxonomy_meta ?? {}), version, bootstrappedAt: nowIso, revisedAt: nowIso };
  // bootstrap 建立首套成形体系：已有分类用的是扁平起步种子、子问题不合规，需重读对齐——
  // 这是破坏性动作（scope=full），按约定写 pending（不自动跑，除非 autoReclassify）
  const pending = {
    proposedAt: nowIso,
    fromVersion: app.taxonomy_meta?.version ?? 0,
    toVersion: version,
    reason: "首次建立成形 taxonomy，历史分类需按新体系重读对齐",
    scope: "full",
    changes: [],
  };

  logTaxonomy(logger, taxonomy);
  if (dryRun) {
    logger.log("[taxonomy] dryRun：不写库。以上为将写入的 bootstrap 结果。");
    return { action: "bootstrap", dryRun: true, version, taxonomy, pendingReclassify: pending };
  }

  await writeTaxonomy(supabase, app, taxonomy, meta, { logger });
  await snapshotRevision(supabase, app, { version, kind: "bootstrap", taxonomy, diff: null, signals: null, appliedRemap: false });
  const pendingResult = await maybeQueueOrRunReclassify({ supabase, app, pending, policy, logger, dryRun, scope: "full" });

  return { action: "bootstrap", version, taxonomy, ...pendingResult };
}

async function runRevision({ supabase, app, callModel, logger, dryRun, signals, policy }) {
  const userPrompt = buildRevisionUserPayload(app, signals, { evidencePerSignal: policy.revisionEvidencePerSignal });
  const parsed = await callModel(buildTaxonomyRevisionPrompt(), userPrompt);
  const verdict = parsed?.verdict === "revise" ? "revise" : "ok";
  logger.log(`[taxonomy] AI verdict=${verdict}（${parsed?.reason ?? ""}）`);

  if (verdict !== "revise") {
    // 重置冷却时间戳，避免下轮立刻重复发问；不改 version
    if (!dryRun) {
      await supabase.from("apps").update({
        taxonomy_meta: { ...(app.taxonomy_meta ?? {}), revisedAt: new Date().toISOString() },
      }).eq("id", app.id);
    }
    return { action: "none", verdict: "ok", reason: parsed?.reason ?? "AI 判定无需修订" };
  }

  let taxonomy = sanitizeTaxonomy(parsed?.taxonomy);
  if (!taxonomy.length) throw new Error("AI 修订返回的 taxonomy 为空");

  const { ensureTaxonomyMinSubs } = await import("./taxonomyEnrich.mjs");
  taxonomy = await ensureTaxonomyMinSubs({ taxonomy, signals, app, callModel, logger });

  const { remaps, reclassifyChanges, affectedKeys: partitionedKeys } = partitionChanges(parsed?.changes);
  const affectedKeys = expandReclassifyAffectedKeys({
    oldCategories: app.seed_categories ?? [],
    taxonomy,
    partitionedKeys,
    signals,
  });
  const version = (app.taxonomy_meta?.version ?? 1) + 1;
  const nowIso = new Date().toISOString();
  const meta = { ...(app.taxonomy_meta ?? {}), version, revisedAt: nowIso, policy: app.taxonomy_meta?.policy ?? undefined };

  logTaxonomy(logger, taxonomy);
  logger.log(`[taxonomy] 修订：remap ${remaps.length} 条、需重读变更 ${reclassifyChanges.length} 项（受影响 key：${affectedKeys.join("、") || "无"}）`);

  if (dryRun) {
    logger.log("[taxonomy] dryRun：不写库。");
    return { action: "revise", dryRun: true, version, taxonomy, remaps, reclassifyChanges, affectedKeys };
  }
  await writeTaxonomy(supabase, app, taxonomy, meta, { logger });
  const remapped = remaps.length
    ? await applyRemapsToReviews({ supabase, app, remaps, logger })
    : 0;
  await snapshotRevision(supabase, app, {
    version, kind: "revision", taxonomy, diff: parsed?.changes ?? [], signals: summarizeSignals(signals), appliedRemap: remaps.length > 0,
  });

  // 4b. 破坏性：写 pending（或在 autoReclassify 时增量重置受影响评论）
  let pendingResult = { pendingReclassify: null };
  if (affectedKeys.length) {
    const pending = {
      proposedAt: nowIso,
      fromVersion: app.taxonomy_meta?.version ?? 1,
      toVersion: version,
      reason: parsed?.reason ?? "类目结构调整，受影响评论需重读",
      scope: "incremental",
      affectedKeys,
      changes: reclassifyChanges,
    };
    pendingResult = await maybeQueueOrRunReclassify({ supabase, app, pending, policy, logger, dryRun, scope: "incremental" });
  }

  return { action: "revise", version, taxonomy, remapped, ...pendingResult };
}

function summarizeSignals(s) {
  return {
    totalClassified: s.totalClassified,
    orphanTopTags: s.orphanTopTags.map((o) => ({ key: o.key, count: o.count })),
    fragmentedSubs: s.fragmentedSubs.length,
    stableUnpromotedSubs: s.stableUnpromotedSubs.length,
    deadCategories: s.deadCategories.map((d) => d.key),
    misrouteSubs: (s.misrouteSubs ?? []).map((m) => ({ parentKey: m.parentKey, subKey: m.subKey, count: m.count, target: m.suggestedTargetKey })),
    crossCategorySubOverlaps: (s.crossCategorySubOverlaps ?? []).length,
    vagueShare: Number(s.vagueShare.toFixed(3)),
  };
}

async function writeTaxonomy(supabase, app, taxonomy, meta, { logger = console } = {}) {
  const oldTaxonomy = app.seed_categories ?? [];
  const sanitized = sanitizeTaxonomy(taxonomy);
  const subLabelRemaps = buildSubLabelRemapsFromTaxonomyDiff(oldTaxonomy, sanitized);
  const { error } = await supabase.from("apps").update({ seed_categories: sanitized, taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  if (subLabelRemaps.length) {
    await applyRemapsToReviews({ supabase, app, remaps: subLabelRemaps, logger });
  }
  return sanitized;
}

/**
 * 已有 taxonomy 若存在跨父类同名 sub，机械消歧并 remap 历史 ai_tags（不触发 AI 修订）。
 * cron-fetch 在分类前调用，避免仅靠消费层兜底。
 */
export async function ensureTaxonomySubLabelDisambiguation({ supabase, app, logger = console }) {
  const current = app.seed_categories ?? [];
  const sanitized = sanitizeTaxonomy(current);
  if (JSON.stringify(sanitized) === JSON.stringify(current)) return app;
  logger.log("[taxonomy] 跨父类同名 sub label 消歧写回 taxonomy");
  await writeTaxonomy(supabase, app, sanitized, app.taxonomy_meta ?? {}, { logger });
  return { ...app, seed_categories: sanitized };
}

async function snapshotRevision(supabase, app, { version, kind, taxonomy, diff, signals, appliedRemap }) {
  const { error } = await supabase.from("taxonomy_revisions").upsert({
    app_id: app.id, version, kind, taxonomy, diff, signals, applied_remap: appliedRemap,
  }, { onConflict: "app_id,version" });
  if (error) throw error;
}

async function applyRemapsToReviews({ supabase, app, remaps, logger }) {
  const sourceKeys = remapSourceKeys(remaps);
  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const updates = [];
  for (const r of reviews) {
    if (!(r.ai_tags ?? []).some((t) => sourceKeys.includes(t.key))) continue;
    const { tags, changed } = applyRemapToTags(r.ai_tags, remaps);
    if (changed) updates.push({ id: r.id, ai_tags: tags, ai_tag_keys: aiTagKeysFromTags(tags) });
  }
  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200);
    await Promise.all(batch.map((u) =>
      supabase.from("reviews").update({ ai_tags: u.ai_tags, ai_tag_keys: u.ai_tag_keys }).eq("id", u.id)
        .then(({ error }) => { if (error) throw error; })
    ));
  }
  logger.log(`[taxonomy] 确定性 remap 改写了 ${updates.length} 条评论的标签`);
  return updates.length;
}

async function maybeQueueOrRunReclassify({ supabase, app, pending, policy, logger, dryRun, scope }) {
  if (dryRun) return { pendingReclassify: pending };

  const autoRun = scope === "full"
    ? Boolean(policy.autoReclassify)
    : Boolean(policy.autoReclassifyIncremental);

  if (!autoRun) {
    const { error } = await supabase.from("apps").update({ pending_reclassify: pending }).eq("id", app.id);
    if (error) throw error;
    logger.log(`[taxonomy] 已写入 pending_reclassify（${scope}），等人工确认后执行 reclassify-app`);
    return { pendingReclassify: pending };
  }

  // autoReclassify：直接重置受影响评论的分类，下轮 cron 会用新体系重读
  const reset = await resetReviewsForReclassify({ supabase, app, scope, affectedKeys: pending.affectedKeys ?? [] });
  await supabase.from("apps").update({ pending_reclassify: null }).eq("id", app.id);
  logger.log(`[taxonomy] autoReclassify 开启（${scope}）：已重置 ${reset} 条评论的分类，下轮 cron 重读`);
  return { pendingReclassify: null, autoReset: reset };
}

/** 重置评论分类（增量：只重置 ai_tags 命中 affectedKeys 的；全量：该 App 全部）。供 autoReclassify 与 CLI 执行器共用 */
export async function resetReviewsForReclassify({ supabase, app, scope, affectedKeys = [] }) {
  if (scope === "full" || !affectedKeys.length) {
    const { count, error } = await supabase
      .from("reviews")
      .update({ ai_tags: [], ai_tag_keys: [], ai_classified_at: null }, { count: "exact" })
      .eq("app_id", app.id)
      .not("ai_classified_at", "is", null);
    if (error) throw error;
    return count ?? 0;
  }
  // 增量：拉出命中 affectedKeys 的评论 id，逐批重置
  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const ids = reviews
    .filter((r) => (r.ai_tags ?? []).some((t) => affectedKeys.includes(t.key)))
    .map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { error } = await supabase
      .from("reviews")
      .update({ ai_tags: [], ai_tag_keys: [], ai_classified_at: null })
      .in("id", batch);
    if (error) throw error;
  }
  return ids.length;
}

/** 重置某父类下 subKey=general（其他）的评论分类，供 general enrich 后重读 */
export async function resetReviewsForCatchAllReclassify({ supabase, app, parentKey }) {
  if (!parentKey) return 0;
  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null),
  );
  const ids = reviews
    .filter((r) =>
      (r.ai_tags ?? []).some((t) => t.key === parentKey && (t.subKey === "general" || t.subLabel === "其他")),
    )
    .map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { error } = await supabase
      .from("reviews")
      .update({ ai_tags: [], ai_tag_keys: [], ai_classified_at: null })
      .in("id", batch);
    if (error) throw error;
  }
  return ids.length;
}

/** 重置命中指定父类 + subKey 的评论分类（用于清理未稳定子问题下的误标） */
export async function resetReviewsForSubReclassify({ supabase, app, parentKey, subKeys = [] }) {
  if (!parentKey || !subKeys.length) return 0;
  const subSet = new Set(subKeys);
  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const ids = reviews
    .filter((r) => (r.ai_tags ?? []).some((t) => t.key === parentKey && t.subKey && subSet.has(t.subKey)))
    .map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const { error } = await supabase
      .from("reviews")
      .update({ ai_tags: [], ai_tag_keys: [], ai_classified_at: null })
      .in("id", batch);
    if (error) throw error;
  }
  return ids.length;
}

/**
 * 重置各父类下低命中、非 taxonomy 设计的 subKey 对应评论（cron / reclassify-low-subs 共用）。
 * @returns {number} 重置条数
 */
export async function resetLowHitSubsForReclassify({
  supabase,
  app,
  seedCategories = [],
  universalSubcategories = {},
  maxCount = LOW_SUB_RECLASSIFY_MAX_COUNT,
  parentKeys = null,
  logger = console,
} = {}) {
  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null),
  );
  const designed = buildDesignedSubKeysByParent(seedCategories, universalSubcategories);
  const lowByParent = findLowHitSubKeys(reviews, { maxCount, designedSubKeysByParent: designed });
  const parents = parentKeys ?? [...lowByParent.keys()];

  let totalReset = 0;
  for (const parentKey of parents) {
    const subKeys = lowByParent.get(parentKey);
    if (!subKeys?.length) continue;
    const reset = await resetReviewsForSubReclassify({ supabase, app, parentKey, subKeys });
    if (reset) {
      logger.log(`[low-subs] ${parentKey}：重置 ${reset} 条（低命中 sub ≤${maxCount}：${subKeys.join("、")}）`);
      totalReset += reset;
    }
  }
  return totalReset;
}

function logTaxonomy(logger, taxonomy) {
  logger.log("[taxonomy] 体系：");
  for (const c of taxonomy) {
    logger.log(`  - ${c.key}(${c.label})：${(c.subcategories ?? []).map((s) => `${s.key}(${s.label})`).join("、") || "（无子问题）"}`);
  }
}
