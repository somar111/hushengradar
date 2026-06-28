// P0 升级：为已有 taxonomy 补 intent、为 feature_request 归纳 App 级子问题。
// P0.5：设计产出写库前做 taxonomy 校准（宽桶/黑话/跨类边界）。
// cron-fetch 在分类前调用；也可单独脚本触发。

import {
  buildEnrichIntentsPrompt,
  buildFeatureRequestSubsPrompt,
  buildGeneralBucketSubsPrompt,
  buildParentSubsPrompt,
  buildTaxonomyDesignCalibratePrompt,
  countDesignedMeaningfulSubs,
  GENERAL_ENRICH_COOLDOWN_DAYS,
  GENERAL_ENRICH_MIN_COUNT,
  hasTaxonomyIntents,
  isCatchAllSubKey,
  MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN,
  NO_SUBTAG_KEYS,
  sanitizeTagKey,
} from "./promptKit.mjs";
import { sanitizeTaxonomy } from "./taxonomy.mjs";
import {
  applyGuardedSubMerge,
  catalogForSubTagGuards,
  filterIncomingSubcategories,
  mergeSubcategoriesGuarded,
} from "./subTagIngestGuards.mjs";

export function getUniversalSubcategories(app) {
  return app?.taxonomy_meta?.universal_subcategories ?? {};
}

function formatCatalogLines(seedCategories = []) {
  return (seedCategories ?? []).flatMap((c) => {
    const subs = (c.subcategories ?? []).map((s) => `${s.key}(${s.label})`).join("、");
    return [`- ${c.key}(${c.label})${subs ? `　子：${subs}` : ""}`];
  });
}

/**
 * P0.5：校准 AI 归纳的子问题清单，不合格则修订后返回。
 */
export async function calibrateDesignedSubcategories({
  callModel,
  logger = console,
  parentKey,
  parentLabel,
  proposedSubs,
  appContext,
  seedCategories = [],
}) {
  if (!proposedSubs?.length) return proposedSubs;

  const userPrompt = [
    `App 背景：${appContext || "（无）"}`,
    `已有 App 专属 taxonomy（勿与之重叠）：\n${formatCatalogLines(seedCategories).join("\n") || "（无）"}`,
    `待校准草稿 subcategories：\n${JSON.stringify(proposedSubs, null, 0)}`,
  ].join("\n\n");

  const parsed = await callModel(
    buildTaxonomyDesignCalibratePrompt({ mode: "subcategories", parentKey, parentLabel }),
    userPrompt,
    { temperature: 0.1 },
  );

  const subs = (parsed?.subcategories ?? proposedSubs)
    .filter((s) => s?.key && s?.label)
    .map((s) => ({ key: sanitizeTagKey(s.key), label: String(s.label).trim() }));

  if (parsed?.verdict === "revise") {
    logger.log(`[taxonomy] P0.5 校准修订子问题(${parentKey})：${parsed.reason ?? ""}`);
  }
  return subs.length ? subs : proposedSubs;
}

/**
 * P0.5：校准完整 taxonomy 草稿（bootstrap / 大修订后）。
 */
export async function calibrateDesignedTaxonomy({ callModel, logger = console, proposedCategories, appContext }) {
  if (!proposedCategories?.length) return proposedCategories;

  const userPrompt = [
    `App 背景：${appContext || "（无）"}`,
    `待校准草稿 taxonomy：\n${JSON.stringify(proposedCategories, null, 0)}`,
  ].join("\n\n");

  const parsed = await callModel(
    buildTaxonomyDesignCalibratePrompt({ mode: "full_taxonomy" }),
    userPrompt,
    { temperature: 0.1 },
  );

  const categories = sanitizeTaxonomy(parsed?.categories ?? proposedCategories);
  if (parsed?.verdict === "revise") {
    logger.log(`[taxonomy] P0.5 校准修订 taxonomy：${parsed.reason ?? ""}`);
  }
  return categories.length ? categories : proposedCategories;
}

/**
 * 若 seed_categories 缺 intent，调 AI 补全并写回 apps。
 * @param {{ force?: boolean }} opts — force 时即使已有 intent 也按最新边界规则重写
 * @returns {Promise<object>} 更新后的 app 行（含 seed_categories）
 */
export async function enrichTaxonomyIntents({ supabase, app, callModel, logger = console, force = false }) {
  if (!force && hasTaxonomyIntents(app.seed_categories)) return app;

  logger.log(force ? "[taxonomy] 强制刷新 App 专属 taxonomy intent…" : "[taxonomy] 检测到 App 专属 taxonomy 缺 intent，补全中…");
  const userPrompt = [
    `这款 App 的背景信息：${app.context || "（无）"}`,
    `当前 taxonomy JSON：\n${JSON.stringify(app.seed_categories ?? [], null, 0)}`,
  ].join("\n\n");

  const parsed = await callModel(buildEnrichIntentsPrompt(), userPrompt);
  const enriched = sanitizeTaxonomy(parsed?.categories);
  if (!enriched.length) {
    logger.warn("[taxonomy] intent 补全返回空，跳过");
    return app;
  }

  const intentByKey = new Map(enriched.map((c) => [c.key, c.intent]));
  const merged = (app.seed_categories ?? []).map((c) => ({
    ...c,
    intent: intentByKey.get(c.key) ?? c.intent,
  }));

  const meta = {
    ...(app.taxonomy_meta ?? {}),
    intentsEnrichedAt: new Date().toISOString(),
    ...(force ? { intentsForceRefreshedAt: new Date().toISOString() } : {}),
  };
  const { error } = await supabase.from("apps").update({ seed_categories: merged, taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  logger.log(`[taxonomy] 已为 ${merged.filter((c) => c.intent).length} 个母类写入 intent`);
  return { ...app, seed_categories: merged, taxonomy_meta: meta };
}

/**
 * 从已标 feature_request 的评论样本归纳 universal 子问题，写入 taxonomy_meta.universal_subcategories。
 * @param {{ force?: boolean }} opts — force 时忽略已有 subs，重新归纳 + P0.5
 */
export async function enrichFeatureRequestSubs({ supabase, app, callModel, logger = console, force = false }) {
  const existing = getUniversalSubcategories(app).feature_request;
  if (!force && existing?.length >= 3) return app;

  const { data: rows, error: qErr } = await supabase
    .from("reviews")
    .select("content, ai_tags")
    .eq("app_id", app.id)
    .not("ai_classified_at", "is", null)
    .contains("ai_tags", JSON.stringify([{ key: "feature_request" }]))
    .limit(80);
  if (qErr) throw qErr;

  const samples = (rows ?? [])
    .map((r) => {
      const fr = (r.ai_tags ?? []).find((t) => t.key === "feature_request");
      return fr?.evidence ? `[${fr.subLabel || fr.subKey || "功能请求"}] ${fr.evidence}` : r.content?.slice(0, 120);
    })
    .filter(Boolean)
    .slice(0, 40);

  if (samples.length < 5) {
    logger.log("[taxonomy] feature_request 样本不足，跳过子问题归纳");
    return app;
  }

  const userPrompt = [
    `App 背景：${app.context || "（无）"}`,
    `已有 App 专属 taxonomy（归纳时勿与之重叠）：\n${formatCatalogLines(app.seed_categories).join("\n") || "（无）"}`,
    `样本（${samples.length} 条）：\n${samples.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  ].join("\n\n");

  const parsed = await callModel(buildFeatureRequestSubsPrompt(), userPrompt);
  let subs = (parsed?.subcategories ?? [])
    .filter((s) => s?.key && s?.label)
    .map((s) => ({ key: sanitizeTagKey(s.key), label: String(s.label).trim() }));

  if (!subs.length) return app;

  subs = await calibrateDesignedSubcategories({
    callModel,
    logger,
    parentKey: "feature_request",
    parentLabel: "功能请求",
    proposedSubs: subs,
    appContext: app.context,
    seedCategories: app.seed_categories,
  });

  if (!subs.length) return app;

  const frCatalog = catalogForSubTagGuards(app.seed_categories, getUniversalSubcategories(app));
  const { accepted } = filterIncomingSubcategories({
    parentKey: "feature_request",
    parentLabel: "功能请求",
    existingSubs: [],
    incoming: subs,
    fullCatalog: frCatalog,
    logger,
  });
  subs = accepted;
  if (!subs.length) return app;

  const universal_subcategories = {
    ...getUniversalSubcategories(app),
    feature_request: subs,
  };
  const meta = {
    ...(app.taxonomy_meta ?? {}),
    universal_subcategories,
    featureRequestSubsAt: new Date().toISOString(),
    ...(force ? { featureRequestSubsForceAt: new Date().toISOString() } : {}),
  };
  const { error } = await supabase.from("apps").update({ taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  logger.log(`[taxonomy] 已写入 feature_request 子问题 ${subs.length} 个：${subs.map((s) => s.label).join("、")}`);
  return { ...app, taxonomy_meta: meta };
}

/** 统计某父类下 subKey=general（其他）的命中条数（一条评论只计一次） */
export function countGeneralHitsInReviews(reviews, parentKey) {
  let count = 0;
  for (const r of reviews ?? []) {
    if ((r.ai_tags ?? []).some((t) => t.key === parentKey && isCatchAllSubKey(t.subKey, t.subLabel))) count++;
  }
  return count;
}

/** 各父类「其他」命中量（不含 praise / vague_complaint） */
export function countGeneralHitsByParent(reviews) {
  const counts = new Map();
  for (const r of reviews ?? []) {
    for (const t of r.ai_tags ?? []) {
      if (NO_SUBTAG_KEYS.has(t.key)) continue;
      if (!isCatchAllSubKey(t.subKey, t.subLabel)) continue;
      counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
    }
  }
  return counts;
}

function resolveParentForGeneralEnrich(app, parentKey) {
  if (parentKey === "feature_request") {
    return {
      label: "功能请求",
      intent: null,
      subs: getUniversalSubcategories(app).feature_request ?? [],
      storage: "universal",
    };
  }
  const cat = (app.seed_categories ?? []).find((c) => c.key === parentKey);
  if (!cat) return null;
  return {
    label: cat.label ?? parentKey,
    intent: cat.intent ?? null,
    subs: cat.subcategories ?? [],
    storage: "seed",
  };
}

function collectGeneralBucketSamples(reviews, parentKey, limit = 40) {
  const samples = [];
  for (const r of reviews ?? []) {
    const tag = (r.ai_tags ?? []).find((t) => t.key === parentKey && isCatchAllSubKey(t.subKey, t.subLabel));
    if (!tag) continue;
    const text = String(tag.evidence ?? "").trim() || String(r.content ?? "").trim();
    if (!text) continue;
    samples.push(`[其他] ${text.slice(0, 200)}`);
    if (samples.length >= limit) break;
  }
  return samples;
}

export function shouldRunGeneralBucketEnrich(app, parentKey, generalCount) {
  if (NO_SUBTAG_KEYS.has(parentKey)) return false;
  if (!resolveParentForGeneralEnrich(app, parentKey)) return false;
  if (generalCount < GENERAL_ENRICH_MIN_COUNT) return false;
  const last = app?.taxonomy_meta?.generalEnrichAt?.[parentKey];
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  return elapsed >= GENERAL_ENRICH_COOLDOWN_DAYS * 86400000;
}

async function touchGeneralEnrichAt({ supabase, app, parentKey, logger }) {
  const meta = {
    ...(app.taxonomy_meta ?? {}),
    generalEnrichAt: {
      ...(app.taxonomy_meta?.generalEnrichAt ?? {}),
      [parentKey]: new Date().toISOString(),
    },
  };
  const { error } = await supabase.from("apps").update({ taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  logger.log(`[general-enrich] 已更新 ${parentKey} generalEnrichAt`);
  return { ...app, taxonomy_meta: meta };
}

/**
 * 从「其他」桶样本归纳新 sub，merge 进 taxonomy（feature_request → universal；App 专属 → seed_categories）。
 * @returns {{ app: object, addedSubs: { key: string, label: string }[] }}
 */
export async function enrichParentFromGeneralBucket({
  supabase,
  app,
  callModel,
  reviews = [],
  parentKey,
  logger = console,
}) {
  const catalog = resolveParentForGeneralEnrich(app, parentKey);
  if (!catalog) {
    logger.log(`[general-enrich] ${parentKey} 无 taxonomy 条目，跳过`);
    return { app, addedSubs: [] };
  }

  const existing = catalog.subs;
  const existingKeys = new Set(existing.map((s) => s.key));
  const samples = collectGeneralBucketSamples(reviews, parentKey);

  if (samples.length < 5) {
    logger.log(`[general-enrich] ${parentKey}「其他」样本不足（${samples.length}），跳过 enrich`);
    return { app: await touchGeneralEnrichAt({ supabase, app, parentKey, logger }), addedSubs: [] };
  }

  const userPrompt = [
    `App 背景：${app.context || "（无）"}`,
    `已有 App 专属 taxonomy（归纳时勿与之重叠）：\n${formatCatalogLines(app.seed_categories).join("\n") || "（无）"}`,
    `母类：${parentKey}(${catalog.label})`,
    catalog.intent ? `intent：${catalog.intent}` : "",
    `「其他」桶样本（${samples.length} 条）：\n${samples.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");

  const parsed = await callModel(
    buildGeneralBucketSubsPrompt({ parentLabel: catalog.label, existingSubs: existing }),
    userPrompt,
  );
  let proposed = (parsed?.subcategories ?? [])
    .filter((s) => s?.key && s?.label)
    .map((s) => ({ key: sanitizeTagKey(s.key), label: String(s.label).trim() }))
    .filter((s) => !existingKeys.has(s.key));

  if (!proposed.length) {
    logger.log(`[general-enrich] ${parentKey} 未归纳出新 sub，跳过重分类`);
    return { app: await touchGeneralEnrichAt({ supabase, app, parentKey, logger }), addedSubs: [] };
  }

  proposed = await calibrateDesignedSubcategories({
    callModel,
    logger,
    parentKey,
    parentLabel: catalog.label,
    proposedSubs: proposed,
    appContext: app.context,
    seedCategories: app.seed_categories,
  });
  proposed = proposed.filter((s) => !existingKeys.has(s.key));
  if (!proposed.length) {
    logger.log(`[general-enrich] ${parentKey} 校准后无新 sub`);
    return { app: await touchGeneralEnrichAt({ supabase, app, parentKey, logger }), addedSubs: [] };
  }

  const guardCatalog = catalogForSubTagGuards(app.seed_categories, getUniversalSubcategories(app));
  const { accepted, rejected } = filterIncomingSubcategories({
    parentKey,
    parentLabel: catalog.label,
    existingSubs: existing,
    incoming: proposed,
    fullCatalog: guardCatalog,
    logger,
  });
  proposed = accepted;
  if (!proposed.length) {
    logger.log(
      `[general-enrich] ${parentKey} 门禁后无新 sub${rejected.length ? `（拒绝 ${rejected.length} 条）` : ""}`,
    );
    return { app: await touchGeneralEnrichAt({ supabase, app, parentKey, logger }), addedSubs: [] };
  }

  const merged = mergeSubcategoriesGuarded(existing, proposed, {
    parentKey,
    parentLabel: catalog.label,
    fullCatalog: guardCatalog,
    logger,
  });
  const generalEnrichAt = {
    ...(app.taxonomy_meta?.generalEnrichAt ?? {}),
    [parentKey]: new Date().toISOString(),
  };

  if (catalog.storage === "universal") {
    const universal_subcategories = {
      ...getUniversalSubcategories(app),
      feature_request: merged,
    };
    const meta = {
      ...(app.taxonomy_meta ?? {}),
      universal_subcategories,
      featureRequestSubsAt: new Date().toISOString(),
      generalEnrichAt,
    };
    const { error } = await supabase.from("apps").update({ taxonomy_meta: meta }).eq("id", app.id);
    if (error) throw error;
    logger.log(
      `[general-enrich] ${parentKey} 从「其他」新增 ${proposed.length} 个子问题：${proposed.map((s) => s.label).join("、")}`,
    );
    return { app: { ...app, taxonomy_meta: meta }, addedSubs: proposed };
  }

  const seed_categories = (app.seed_categories ?? []).map((c) =>
    c.key === parentKey ? { ...c, subcategories: merged } : c,
  );
  const meta = { ...(app.taxonomy_meta ?? {}), generalEnrichAt, revisedAt: new Date().toISOString() };
  const { error } = await supabase.from("apps").update({ seed_categories, taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  logger.log(
    `[general-enrich] ${parentKey} 从「其他」新增 ${proposed.length} 个子问题：${proposed.map((s) => s.label).join("、")}`,
  );
  return { app: { ...app, seed_categories, taxonomy_meta: meta }, addedSubs: proposed };
}

/** @deprecated 使用 enrichParentFromGeneralBucket */
export async function enrichFeatureRequestFromGeneralBucket(opts) {
  return enrichParentFromGeneralBucket({ ...opts, parentKey: "feature_request" });
}

/**
 * 信号驱动：各父类「其他」够多且过冷却 → enrich 新 sub → 由调用方按 parent  reset general 并重分类。
 * @returns {{ app: object, results: { parentKey: string, addedSubs: object[], generalCount: number }[] }}
 */
export async function runGeneralBucketEnrichStage({ supabase, app, callModel, reviews, logger = console }) {
  const byParent = countGeneralHitsByParent(reviews);
  const results = [];

  for (const [parentKey, generalCount] of byParent) {
    if (!shouldRunGeneralBucketEnrich(app, parentKey, generalCount)) {
      if (generalCount >= GENERAL_ENRICH_MIN_COUNT) {
        logger.log(`[general-enrich] ${parentKey}「其他」${generalCount} 条，冷却期内跳过`);
      }
      continue;
    }

    logger.log(`[general-enrich] ${parentKey}「其他」${generalCount} 条 ≥ ${GENERAL_ENRICH_MIN_COUNT}，开始 enrich…`);
    const { app: nextApp, addedSubs } = await enrichParentFromGeneralBucket({
      supabase,
      app,
      callModel,
      reviews,
      parentKey,
      logger,
    });
    app = nextApp;
    if (addedSubs.length) results.push({ parentKey, addedSubs, generalCount });
  }

  return { app, results };
}

/**
 * 修订/bootstrap 写库前：App 专属母类有效 sub 不足时，用孤儿信号样本或语义拆分补足（与 Top 反馈 chip 门槛对齐）。
 * @param {object} opts
 * @param {object[]} opts.taxonomy sanitize 后的 categories
 * @param {{ orphanTopTags?: { key: string, samples?: string[] }[] }} [opts.signals]
 * @param {{ context?: string|null, seed_categories?: object[] }} opts.app
 * @param {(system: string, user: string, extra?: object) => Promise<object>} opts.callModel
 */
export async function ensureTaxonomyMinSubs({ taxonomy, signals, app, callModel, logger = console }) {
  if (!taxonomy?.length) return taxonomy;

  const orphanByKey = new Map((signals?.orphanTopTags ?? []).map((o) => [o.key, o]));
  const out = [];

  for (const c of taxonomy) {
    let subs = [...(c.subcategories ?? [])];
    if (countDesignedMeaningfulSubs(subs) >= MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN) {
      out.push(c);
      continue;
    }

    const orphan = orphanByKey.get(c.key);
    const samples = (orphan?.samples ?? []).filter(Boolean).slice(0, 40);
    let userPrompt;

    if (samples.length >= 3) {
      logger.log(
        `[taxonomy] ${c.key} 有效 sub 仅 ${countDesignedMeaningfulSubs(subs)} 个，从孤儿信号归纳补足…`,
      );
      userPrompt = [
        `App 背景：${app.context || "（无）"}`,
        `已有 App 专属 taxonomy（归纳时勿与之重叠）：\n${formatCatalogLines(taxonomy).join("\n") || "（无）"}`,
        `母类：${c.key}(${c.label})`,
        c.intent ? `intent：${c.intent}` : "",
        `当前 subcategories 草稿：${JSON.stringify(subs)}`,
        `样本（${samples.length} 条）：\n${samples.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      ].join("\n\n");
    } else {
      logger.log(
        `[taxonomy] ${c.key} 有效 sub 仅 ${countDesignedMeaningfulSubs(subs)} 个，按母类语义拆分补足…`,
      );
      userPrompt = [
        `App 背景：${app.context || "（无）"}`,
        `母类：${c.key}(${c.label})`,
        c.intent ? `intent：${c.intent}` : "",
        `当前 subcategories 草稿：${JSON.stringify(subs)}`,
        `有效子问题不足 ${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN} 个。请基于母类语义拆成至少 ${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN} 个互斥、可分类的具体子问题。`,
      ].join("\n\n");
    }

    const parsed = await callModel(buildParentSubsPrompt({ parentLabel: c.label, intent: c.intent }), userPrompt);
    const guardCatalog = catalogForSubTagGuards(taxonomy, getUniversalSubcategories(app));
    let proposed = mergeSubcategoriesGuarded(subs, parsed?.subcategories ?? [], {
      parentKey: c.key,
      parentLabel: c.label,
      fullCatalog: guardCatalog,
      logger,
    });
    proposed = await calibrateDesignedSubcategories({
      callModel,
      logger,
      parentKey: c.key,
      parentLabel: c.label,
      proposedSubs: proposed,
      appContext: app.context,
      seedCategories: taxonomy,
    });
    proposed = applyGuardedSubMerge(subs, proposed, {
      parentKey: c.key,
      parentLabel: c.label,
      fullCatalog: guardCatalog,
      logger,
    });

    if (countDesignedMeaningfulSubs(proposed) < MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN) {
      logger.warn(
        `[taxonomy] ${c.key} 补足后仍仅 ${countDesignedMeaningfulSubs(proposed)} 个有效 sub（目标 ≥${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN}）`,
      );
    } else {
      logger.log(`[taxonomy] ${c.key} 已补足 ${countDesignedMeaningfulSubs(proposed)} 个有效 sub`);
    }

    out.push({ ...c, subcategories: proposed });
  }

  return out;
}
