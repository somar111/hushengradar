#!/usr/bin/env node
/**
 * 修正 taxonomy / 评论里子问题 label 尾部括号举例（如…、…等），并重置受影响评论供 cron 重分类。
 *
 *   node --env-file=.env.local scripts/fix-sub-label-example-parens.mjs              # 预览
 *   node --env-file=.env.local scripts/fix-sub-label-example-parens.mjs --apply      # 写库 + 重置
 *   node --env-file=.env.local scripts/fix-sub-label-example-parens.mjs cn.wps... --apply
 */
import { createClient } from "@supabase/supabase-js";
import { normalizeSubcategoryLabel } from "../lib/promptKit.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const applyMode = process.argv.includes("--apply");
const appFilter = process.argv.find((a) => a !== "--apply" && !a.endsWith(".mjs") && !a.includes("node"));

function normalizeSubs(subs = []) {
  return (subs ?? []).map((s) => {
    if (!s?.key || !s?.label) return s;
    const label = normalizeSubcategoryLabel(s.label);
    return label === s.label ? s : { ...s, label };
  });
}

function normalizeSeedCategories(seedCategories = []) {
  let changed = false;
  const next = (seedCategories ?? []).map((c) => {
    const subcategories = normalizeSubs(c.subcategories);
    if (subcategories.some((s, i) => s.label !== c.subcategories?.[i]?.label)) changed = true;
    return { ...c, subcategories };
  });
  return { seed_categories: next, changed };
}

function normalizeUniversal(universal = {}) {
  let changed = false;
  const next = { ...universal };
  for (const [parentKey, subs] of Object.entries(universal ?? {})) {
    const normalized = normalizeSubs(subs);
    if (normalized.some((s, i) => s.label !== subs?.[i]?.label)) {
      changed = true;
      next[parentKey] = normalized;
    }
  }
  return { universal_subcategories: next, changed };
}

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


async function planAppFix(app) {
  const { seed_categories, changed: seedChanged } = normalizeSeedCategories(app.seed_categories);
  const universal = app.taxonomy_meta?.universal_subcategories ?? {};
  const { universal_subcategories, changed: uniChanged } = normalizeUniversal(universal);
  if (!seedChanged && !uniChanged) return null;

  const taxonomyChanges = [];
  for (const c of app.seed_categories ?? []) {
    for (const s of c.subcategories ?? []) {
      const next = normalizeSubcategoryLabel(s.label);
      if (next !== s.label) {
        taxonomyChanges.push({ scope: "seed", parentKey: c.key, subKey: s.key, from: s.label, to: next });
      }
    }
  }
  for (const [parentKey, subs] of Object.entries(universal ?? {})) {
    for (const s of subs ?? []) {
      const next = normalizeSubcategoryLabel(s.label);
      if (next !== s.label) {
        taxonomyChanges.push({ scope: "universal", parentKey, subKey: s.key, from: s.label, to: next });
      }
    }
  }

  const reviews = await fetchAllRows(
    supabase
      .from("reviews")
      .select("id, ai_tags")
      .eq("app_id", app.id)
      .not("ai_classified_at", "is", null),
  );

  const changedSubIds = new Set(
    taxonomyChanges.map((c) => `${c.parentKey}\0${c.subKey}`),
  );

  const resetIds = new Set();

  for (const r of reviews) {
    const needsReset = (r.ai_tags ?? []).some((t) => {
      if (!t?.subKey) return false;
      const id = `${t.key}\0${t.subKey}`;
      if (changedSubIds.has(id)) return true;
      if (!t.subLabel) return false;
      return normalizeSubcategoryLabel(t.subLabel) !== t.subLabel;
    });
    if (needsReset) resetIds.add(r.id);
  }

  return {
    seed_categories,
    taxonomy_meta: { ...(app.taxonomy_meta ?? {}), universal_subcategories },
    taxonomyChanges,
    resetIds: [...resetIds],
  };
}

async function applyAppFix(app, plan) {
  const { error } = await supabase
    .from("apps")
    .update({
      seed_categories: plan.seed_categories,
      taxonomy_meta: plan.taxonomy_meta,
    })
    .eq("id", app.id);
  if (error) throw error;

  for (let i = 0; i < plan.resetIds.length; i += 200) {
    const batch = plan.resetIds.slice(i, i + 200);
    const { error: resetErr } = await supabase
      .from("reviews")
      .update({ ai_tags: [], ai_tag_keys: [], ai_classified_at: null })
      .in("id", batch);
    if (resetErr) throw resetErr;
  }
}

async function main() {
  let query = supabase.from("apps").select("id, display_name, external_id, seed_categories, taxonomy_meta");
  if (appFilter) {
    query = query.or(`display_name.eq.${appFilter},external_id.eq.${appFilter}`);
  }

  const { data: apps, error } = await query;
  if (error) throw error;
  if (!apps?.length) {
    console.log(appFilter ? `未找到 App: ${appFilter}` : "无 App");
    return;
  }

  let totalTaxonomy = 0;
  let totalReset = 0;

  for (const app of apps) {
    const plan = await planAppFix(app);
    if (!plan) continue;

    console.log(`\n=== ${app.display_name ?? app.external_id ?? app.id} ===`);
    for (const c of plan.taxonomyChanges) {
      console.log(`[taxonomy/${c.scope}] ${c.parentKey}/${c.subKey}: ${c.from} → ${c.to}`);
      totalTaxonomy++;
    }
    console.log(`[reviews] ${plan.resetIds.length} 条将重置分类（cron 重跑）`);
    totalReset += plan.resetIds.length;

    if (applyMode) {
      await applyAppFix(app, plan);
      console.log("已写库并重置");
    }
  }

  if (!totalTaxonomy && !totalReset) {
    console.log("未发现需修正的括号举例 label。");
    return;
  }

  if (!applyMode) {
    console.log(`\n预览合计：taxonomy ${totalTaxonomy} 处，重置评论 ${totalReset} 条。确认后执行：`);
    console.log("node --env-file=.env.local scripts/fix-sub-label-example-parens.mjs --apply");
    if (totalReset) {
      console.log("然后对受影响 App 跑：node --env-file=.env.local scripts/cron-fetch.mjs <external_id>");
    }
  } else {
    console.log(`\n完成：taxonomy ${totalTaxonomy} 处，重置评论 ${totalReset} 条。请跑 cron-fetch 完成重分类。`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
