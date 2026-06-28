#!/usr/bin/env node
/**
 * 跨父类同名 sub label 消歧：更新 apps.seed_categories + 确定性 remap ai_tags.subLabel。
 * 0 次 LLM，不重分类。
 *
 *   node --env-file=.env.local scripts/disambiguate-sub-labels.mjs           # 预览
 *   node --env-file=.env.local scripts/disambiguate-sub-labels.mjs --apply   # 写库
 */
import { createClient } from "@supabase/supabase-js";
import {
  applyRemapToTags,
  buildSubLabelRemapsFromTaxonomyDiff,
  ensureTaxonomySubLabelDisambiguation,
  remapSourceKeys,
  sanitizeTaxonomy,
} from "../lib/taxonomy.mjs";
import { aiTagKeysFromTags, labelsTooSimilar } from "../lib/promptKit.mjs";
import { ensureParentSuffix } from "../lib/subTagIngestGuards.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const applyMode = process.argv.includes("--apply");
const appFilter = process.argv.find((a) => a !== "--apply" && !a.endsWith(".mjs") && !a.includes("node"));

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
  const oldMap = new Map();
  for (const c of oldCategories ?? []) {
    for (const s of c.subcategories ?? []) {
      oldMap.set(`${c.key}\0${s.key}`, { parent: c.label, sub: s.label });
    }
  }
  const changes = [];
  for (const c of newCategories ?? []) {
    for (const s of c.subcategories ?? []) {
      const id = `${c.key}\0${s.key}`;
      const prev = oldMap.get(id);
      if (prev && prev.sub !== s.label) {
        changes.push({
          parentKey: c.key,
          parentLabel: c.label,
          subKey: s.key,
          from: prev.sub,
          to: s.label,
        });
      }
    }
  }
  return changes;
}

function aggregateSubTags(reviews) {
  const byId = new Map();
  for (const r of reviews) {
    for (const t of r.ai_tags ?? []) {
      if (!t?.key || !t?.subKey || t.subKey === "general") continue;
      const id = `${t.key}\0${t.subKey}`;
      const e = byId.get(id) ?? {
        parentKey: t.key,
        parentLabel: t.label,
        subKey: t.subKey,
        subLabel: t.subLabel || t.subKey,
        count: 0,
      };
      e.count++;
      if (t.subLabel) e.subLabel = t.subLabel;
      if (t.label) e.parentLabel = t.label;
      byId.set(id, e);
    }
  }
  return [...byId.values()];
}

/** 评论实况里跨父类撞名/近义的 (parentKey, subKey) 须加父类后缀 */
function collectReviewCollisionIds(reviews) {
  const entries = aggregateSubTags(reviews);
  const collisionIds = new Map(); // id -> parentLabel（用于后缀）

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.parentKey === b.parentKey) continue;
      if (!labelsTooSimilar(a.subLabel, b.subLabel)) continue;
      collisionIds.set(`${a.parentKey}\0${a.subKey}`, a.parentLabel);
      collisionIds.set(`${b.parentKey}\0${b.subKey}`, b.parentLabel);
    }
  }
  return collisionIds;
}

function disambiguateTagsForCollisions(aiTags, collisionIds) {
  let changed = false;
  const tags = (aiTags ?? []).map((t) => {
    if (!t?.subKey || t.subKey === "general") return t;
    const id = `${t.key}\0${t.subKey}`;
    const parentLabel = collisionIds.get(id);
    if (!parentLabel) return t;
    const base = t.subLabel || t.subKey;
    const next = ensureParentSuffix(base, parentLabel);
    if (next === t.subLabel) return t;
    changed = true;
    return { ...t, subLabel: next };
  });
  return { tags, changed };
}

function patchTaxonomyForCollisions(seedCategories, collisionIds) {
  if (!collisionIds.size) return seedCategories;
  return (seedCategories ?? []).map((c) => ({
    ...c,
    subcategories: (c.subcategories ?? []).map((s) => {
      const id = `${c.key}\0${s.key}`;
      if (!collisionIds.has(id)) return s;
      const next = ensureParentSuffix(s.label, c.label);
      return next === s.label ? s : { ...s, label: next };
    }),
  }));
}

function countTaxonomyRemaps(reviews, remaps) {
  const sourceKeys = remapSourceKeys(remaps);
  let n = 0;
  for (const r of reviews) {
    if (!(r.ai_tags ?? []).some((t) => sourceKeys.includes(t.key))) continue;
    const { changed } = applyRemapToTags(r.ai_tags, remaps);
    if (changed) n++;
  }
  return n;
}

function countReviewCollisionRemaps(reviews, collisionIds) {
  let n = 0;
  for (const r of reviews) {
    const { changed } = disambiguateTagsForCollisions(r.ai_tags, collisionIds);
    if (changed) n++;
  }
  return n;
}

async function previewApp(app) {
  const current = app.seed_categories ?? [];
  const sanitized = sanitizeTaxonomy(current);
  const taxonomyLabelChanges = diffTaxonomyLabels(current, sanitized);
  const taxonomyRemaps = buildSubLabelRemapsFromTaxonomyDiff(current, sanitized);

  const reviews = await fetchAllRows(
    supabase
      .from("reviews")
      .select("id, ai_tags")
      .eq("app_id", app.id)
      .not("ai_classified_at", "is", null),
  );

  const collisionIds = collectReviewCollisionIds(reviews);
  const patchedSeed = patchTaxonomyForCollisions(sanitized, collisionIds);
  const reviewCollisionChanges = diffTaxonomyLabels(sanitized, patchedSeed);

  const taxonomyReviewUpdates = countTaxonomyRemaps(reviews, taxonomyRemaps);
  const collisionReviewUpdates = countReviewCollisionRemaps(reviews, collisionIds);

  return {
    app,
    reviews,
    taxonomyLabelChanges,
    reviewCollisionChanges,
    collisionIds,
    patchedSeed,
    classifiedTotal: reviews.length,
    taxonomyReviewUpdates,
    collisionReviewUpdates,
    totalReviewUpdates: taxonomyReviewUpdates + collisionReviewUpdates,
  };
}

async function applyReviewCollisionRemaps(appId, reviews, collisionIds) {
  const updates = [];
  for (const r of reviews) {
    const { tags, changed } = disambiguateTagsForCollisions(r.ai_tags, collisionIds);
    if (!changed) continue;
    updates.push({ id: r.id, ai_tags: tags, ai_tag_keys: aiTagKeysFromTags(tags) });
  }
  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200);
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
  return updates.length;
}

async function main() {
  let query = supabase.from("apps").select("id, display_name, seed_categories, taxonomy_meta");
  if (appFilter) query = query.eq("id", appFilter);
  const { data: apps, error } = await query;
  if (error) throw error;
  if (!apps?.length) throw new Error(appFilter ? `找不到 App: ${appFilter}` : "无 App");

  console.log(applyMode ? "=== 写库模式 --apply ===\n" : "=== 预览模式（加 --apply 写库）===\n");

  for (const app of apps) {
    const report = await previewApp(app);
    console.log("=".repeat(72));
    console.log(`${app.display_name} (${app.id})`);
    console.log("=".repeat(72));

    if (report.taxonomyLabelChanges.length) {
      console.log(`\n[taxonomy sanitize] sub label 变更：${report.taxonomyLabelChanges.length} 处`);
      for (const c of report.taxonomyLabelChanges) {
        console.log(`  - ${c.parentLabel}/${c.subKey}: 「${c.from}」→「${c.to}」`);
      }
      console.log(`  → 评论 remap：${report.taxonomyReviewUpdates} 条`);
    }

    if (report.collisionIds.size) {
      console.log(`\n[评论实况撞名] 涉及 ${report.collisionIds.size} 个 (父类,subKey) 组合`);
      for (const [id, parentLabel] of report.collisionIds) {
        const [parentKey, subKey] = id.split("\0");
        console.log(`  - ${parentKey}/${subKey}（后缀用「${parentLabel}」）`);
      }
      if (report.reviewCollisionChanges.length) {
        console.log(`  taxonomy 同步补丁：${report.reviewCollisionChanges.length} 处`);
        for (const c of report.reviewCollisionChanges) {
          console.log(`    - ${c.parentLabel}/${c.subKey}: 「${c.from}」→「${c.to}」`);
        }
      }
      console.log(`  → 评论 remap：${report.collisionReviewUpdates} 条`);
    }

    if (!report.taxonomyLabelChanges.length && !report.collisionIds.size) {
      console.log("\n无需变更。\n");
      continue;
    }

    console.log(
      `\n合计将更新评论：${report.totalReviewUpdates} / ${report.classifiedTotal} 条（0 次 LLM）`,
    );

    if (applyMode) {
      if (report.taxonomyLabelChanges.length) {
        await ensureTaxonomySubLabelDisambiguation({ supabase, app, logger: console });
        app.seed_categories = (
          await supabase.from("apps").select("seed_categories").eq("id", app.id).single()
        ).data.seed_categories;
      }

      if (report.collisionIds.size) {
        const patched = patchTaxonomyForCollisions(app.seed_categories, report.collisionIds);
        if (JSON.stringify(patched) !== JSON.stringify(app.seed_categories)) {
          const { error: upErr } = await supabase
            .from("apps")
            .update({ seed_categories: patched })
            .eq("id", app.id);
          if (upErr) throw upErr;
          console.log(`[taxonomy] 已同步评论撞名补丁 ${report.reviewCollisionChanges.length} 处`);
        }
        const n = await applyReviewCollisionRemaps(app.id, report.reviews, report.collisionIds);
        console.log(`[reviews] 评论撞名消歧已写 ${n} 条`);
      }

      console.log("\n✓ 完成\n");
    } else {
      console.log("");
    }
  }

  if (!applyMode) {
    console.log("确认后执行：node --env-file=.env.local scripts/disambiguate-sub-labels.mjs --apply");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
