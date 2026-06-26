// P0 升级：为已有 taxonomy 补 intent、为 feature_request 归纳 App 级子问题。
// P0.5：设计产出写库前做 taxonomy 校准（宽桶/黑话/跨类边界）。
// cron-fetch 在分类前调用；也可单独脚本触发。

import {
  buildEnrichIntentsPrompt,
  buildFeatureRequestSubsPrompt,
  buildTaxonomyDesignCalibratePrompt,
  hasTaxonomyIntents,
  sanitizeTagKey,
} from "./promptKit.mjs";
import { sanitizeTaxonomy } from "./taxonomy.mjs";

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
    .contains("ai_tag_keys", ["feature_request"])
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
