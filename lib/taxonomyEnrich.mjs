// P0 升级：为已有 taxonomy 补 intent、为 feature_request 归纳 App 级子问题。
// cron-fetch 在分类前调用；也可单独脚本触发。

import {
  buildEnrichIntentsPrompt,
  buildFeatureRequestSubsPrompt,
  hasTaxonomyIntents,
  sanitizeTagKey,
} from "./promptKit.mjs";
import { sanitizeTaxonomy } from "./taxonomy.mjs";

export function getUniversalSubcategories(app) {
  return app?.taxonomy_meta?.universal_subcategories ?? {};
}

/**
 * 若 seed_categories 缺 intent，调 AI 补全并写回 apps。
 * @returns {Promise<object>} 更新后的 app 行（含 seed_categories）
 */
export async function enrichTaxonomyIntents({ supabase, app, callModel, logger = console }) {
  if (hasTaxonomyIntents(app.seed_categories)) return app;

  logger.log("[taxonomy] 检测到 App 专属 taxonomy 缺 intent，补全中…");
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

  const meta = { ...(app.taxonomy_meta ?? {}), intentsEnrichedAt: new Date().toISOString() };
  const { error } = await supabase.from("apps").update({ seed_categories: merged, taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  logger.log(`[taxonomy] 已为 ${merged.filter((c) => c.intent).length} 个母类写入 intent`);
  return { ...app, seed_categories: merged, taxonomy_meta: meta };
}

/**
 * 从已标 feature_request 的评论样本归纳 universal 子问题，写入 taxonomy_meta.universal_subcategories。
 */
export async function enrichFeatureRequestSubs({ supabase, app, callModel, logger = console }) {
  const existing = getUniversalSubcategories(app).feature_request;
  if (existing?.length >= 3) return app;

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
    `样本（${samples.length} 条）：\n${samples.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  ].join("\n\n");

  const parsed = await callModel(buildFeatureRequestSubsPrompt(), userPrompt);
  const subs = (parsed?.subcategories ?? [])
    .filter((s) => s?.key && s?.label)
    .map((s) => ({ key: sanitizeTagKey(s.key), label: String(s.label).trim() }));

  if (!subs.length) return app;

  const universal_subcategories = {
    ...getUniversalSubcategories(app),
    feature_request: subs,
  };
  const meta = {
    ...(app.taxonomy_meta ?? {}),
    universal_subcategories,
    featureRequestSubsAt: new Date().toISOString(),
  };
  const { error } = await supabase.from("apps").update({ taxonomy_meta: meta }).eq("id", app.id);
  if (error) throw error;
  logger.log(`[taxonomy] 已写入 feature_request 子问题 ${subs.length} 个`);
  return { ...app, taxonomy_meta: meta };
}
