#!/usr/bin/env node
/**
 * 撤销跨父类 sub label 消歧：去掉 taxonomy / 评论里「（父类）」机械后缀。
 *
 *   node --env-file=.env.local scripts/revert-sub-label-disambiguation.mjs           # 预览
 *   node --env-file=.env.local scripts/revert-sub-label-disambiguation.mjs --apply   # 写库
 */
import { createClient } from "@supabase/supabase-js";
import {
  applyRemapToTags,
  buildSubLabelRemapsFromTaxonomyDiff,
  remapSourceKeys,
  sanitizeTaxonomy,
} from "../lib/taxonomy.mjs";
import { aiTagKeysFromTags } from "../lib/promptKit.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const applyMode = process.argv.includes("--apply");
const appFilter = process.argv.find((a) => a !== "--apply" && !a.endsWith(".mjs") && !a.includes("node"));

function stripParentSuffix(label, parentLabel) {
  const suffix = `（${parentLabel}）`;
  if (!label || !parentLabel || !label.endsWith(suffix)) return label;
  return label.slice(0, -suffix.length);
}

function stripDisambiguationFromTaxonomy(seedCategories = []) {
  return (seedCategories ?? []).map((cat) => ({
    ...cat,
    subcategories: (cat.subcategories ?? []).map((sub) => {
      const next = stripParentSuffix(String(sub.label ?? "").trim(), cat.label);
      return next === sub.label ? sub : { ...sub, label: next };
    }),
  }));
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

function diffTaxonomyLabels(oldCategories, newCategories) {
  const changes = [];
  const oldMap = new Map();
  for (const c of oldCategories ?? []) {
    for (const s of c.subcategories ?? []) {
      oldMap.set(`${c.key}\0${s.key}`, s.label);
    }
  }
  for (const c of newCategories ?? []) {
    for (const s of c.subcategories ?? []) {
      const id = `${c.key}\0${s.key}`;
      const prev = oldMap.get(id);
      if (prev && prev !== s.label) {
        changes.push({
          parentKey: c.key,
          parentLabel: c.label,
          subKey: s.key,
          from: prev,
          to: s.label,
        });
      }
    }
  }
  return changes;
}

async function revertApp(app) {
  const current = app.seed_categories ?? [];
  const stripped = stripDisambiguationFromTaxonomy(current);
  const sanitized = sanitizeTaxonomy(stripped);
  const taxonomyChanges = diffTaxonomyLabels(current, sanitized);
  const taxonomyRemaps = buildSubLabelRemapsFromTaxonomyDiff(current, sanitized);

  const reviews = await fetchAllRows(
    supabase
      .from("reviews")
      .select("id, ai_tags")
      .eq("app_id", app.id)
      .not("ai_classified_at", "is", null),
  );

  const parentLabelByKey = new Map((sanitized ?? []).map((c) => [c.key, c.label]));
  const reviewUpdates = [];
  for (const r of reviews) {
    let changed = false;
    const tags = (r.ai_tags ?? []).map((t) => {
      if (!t?.subKey || !t.subLabel) return t;
      const parentLabel = parentLabelByKey.get(t.key) ?? t.label;
      const next = stripParentSuffix(String(t.subLabel).trim(), parentLabel);
      if (next === t.subLabel) return t;
      changed = true;
      return { ...t, subLabel: next };
    });
    if (changed) {
      reviewUpdates.push({
        id: r.id,
        ai_tags: tags,
        ai_tag_keys: aiTagKeysFromTags(tags),
      });
    }
  }

  return { taxonomyChanges, taxonomyRemaps, reviewUpdates, sanitized };
}

async function applyAppRevert(app, { taxonomyChanges, taxonomyRemaps, reviewUpdates, sanitized }) {
  if (taxonomyChanges.length) {
    const { error } = await supabase
      .from("apps")
      .update({ seed_categories: sanitized })
      .eq("id", app.id);
    if (error) throw error;
  }

  const sourceKeys = remapSourceKeys(taxonomyRemaps);
  if (sourceKeys.length) {
    for (const r of await fetchAllRows(
      supabase
        .from("reviews")
        .select("id, ai_tags")
        .eq("app_id", app.id)
        .not("ai_classified_at", "is", null),
    )) {
      if (!(r.ai_tags ?? []).some((t) => sourceKeys.includes(t.key))) continue;
      const { tags, changed } = applyRemapToTags(r.ai_tags, taxonomyRemaps);
      if (!changed) continue;
      const idx = reviewUpdates.findIndex((u) => u.id === r.id);
      const row = {
        id: r.id,
        ai_tags: tags,
        ai_tag_keys: aiTagKeysFromTags(tags),
      };
      if (idx >= 0) reviewUpdates[idx] = row;
      else reviewUpdates.push(row);
    }
  }

  for (let i = 0; i < reviewUpdates.length; i += 200) {
    const batch = reviewUpdates.slice(i, i + 200);
    await Promise.all(
      batch.map((u) =>
        supabase
          .from("reviews")
          .update({ ai_tags: u.ai_tags, ai_tag_keys: u.ai_tag_keys })
          .eq("id", u.id)
          .then(({ error }) => {
            if (error) throw error;
          }),
      ),
    );
  }
}

async function main() {
  let query = supabase.from("apps").select("id, display_name, external_id, seed_categories");
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
  let totalReviews = 0;

  for (const app of apps) {
    const result = await revertApp(app);
    if (!result.taxonomyChanges.length && !result.reviewUpdates.length) continue;

    console.log(`\n=== ${app.display_name ?? app.external_id ?? app.id} ===`);
    if (result.taxonomyChanges.length) {
      console.log(`[taxonomy] ${result.taxonomyChanges.length} 处后缀将去除：`);
      for (const c of result.taxonomyChanges) {
        console.log(`  ${c.parentKey}/${c.subKey}: ${c.from} → ${c.to}`);
      }
      totalTaxonomy += result.taxonomyChanges.length;
    }
    if (result.reviewUpdates.length) {
      console.log(`[reviews] ${result.reviewUpdates.length} 条评论 subLabel 将还原`);
      totalReviews += result.reviewUpdates.length;
    }

    if (applyMode) {
      await applyAppRevert(app, result);
      console.log("已写库");
    }
  }

  if (!totalTaxonomy && !totalReviews) {
    console.log("未发现可撤销的消歧后缀。");
    return;
  }

  if (!applyMode) {
    console.log(
      `\n预览合计：taxonomy ${totalTaxonomy} 处，评论 ${totalReviews} 条。确认后执行：`,
    );
    console.log("node --env-file=.env.local scripts/revert-sub-label-disambiguation.mjs --apply");
  } else {
    console.log(`\n完成：taxonomy ${totalTaxonomy} 处，评论 ${totalReviews} 条。`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
