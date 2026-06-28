#!/usr/bin/env node
/**
 * 只读审计：各 App taxonomy + 已分类评论里跨父类同名/近义 sub。
 * 用法：node scripts/audit-cross-sub-overlaps.mjs
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  findCrossCategorySubOverlaps,
  labelsTooSimilar,
  normalizeComparableText,
  buildCategoryCatalog,
} from "../lib/promptKit.mjs";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
  return createClient(url, key);
}

function overlapsFromReviewTags(reviews) {
  const byParentSub = new Map(); // parent\0subKey -> { label, count }
  for (const r of reviews) {
    for (const t of r.ai_tags ?? []) {
      if (!t?.key || !t?.subKey || t.subKey === "general") continue;
      const id = `${t.key}\0${t.subKey}`;
      const e = byParentSub.get(id) ?? {
        parentKey: t.key,
        parentLabel: t.label,
        subKey: t.subKey,
        subLabel: t.subLabel || t.subKey,
        count: 0,
      };
      e.count++;
      if (t.subLabel) e.subLabel = t.subLabel;
      if (t.label) e.parentLabel = t.label;
      byParentSub.set(id, e);
    }
  }
  const entries = [...byParentSub.values()];
  const pairs = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.parentKey === b.parentKey) continue;
      const exact = normalizeComparableText(a.subLabel) === normalizeComparableText(b.subLabel);
      const similar = labelsTooSimilar(a.subLabel, b.subLabel);
      if (!exact && !similar) continue;
      pairs.push({
        parentA: a.parentKey,
        parentALabel: a.parentLabel,
        subA: a.subKey,
        subALabel: a.subLabel,
        countA: a.count,
        parentB: b.parentKey,
        parentBLabel: b.parentLabel,
        subB: b.subKey,
        subBLabel: b.subLabel,
        countB: b.count,
        reason: exact ? "完全相同 label" : "近义 label",
        reviewHits: a.count + b.count,
      });
    }
  }
  return pairs.sort((x, y) => y.reviewHits - x.reviewHits);
}

async function fetchAllReviews(supabase, appId) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("reviews")
      .select("id, ai_tags")
      .eq("app_id", appId)
      .not("ai_classified_at", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  const supabase = getSupabase();
  const { data: apps, error } = await supabase.from("apps").select("id, display_name, seed_categories, taxonomy_meta");
  if (error) throw error;

  console.log(`共 ${apps.length} 个 App\n`);

  for (const app of apps) {
    console.log("=".repeat(72));
    console.log(`${app.display_name} (${app.id})`);
    console.log("=".repeat(72));

    const universal = app.taxonomy_meta?.universal_subcategories ?? {};
    const catalog = buildCategoryCatalog(app.seed_categories ?? [], universal);
    const taxonomyOverlaps = findCrossCategorySubOverlaps(app.seed_categories ?? []);
    const reviews = await fetchAllReviews(supabase, app.id);

    console.log(`\n【taxonomy 设计稿】跨父类撞名/近义：${taxonomyOverlaps.length} 组`);
    for (const o of taxonomyOverlaps) {
      const countA = countTagSub(reviews, o.parentA, o.subA);
      const countB = countTagSub(reviews, o.parentB, o.subB);
      console.log(
        `  - ${o.parentALabel}/${o.subALabel} (${o.parentA}/${o.subA}, ${countA}条) ↔ ${o.parentBLabel}/${o.subBLabel} (${o.parentB}/${o.subB}, ${countB}条) [${o.reason}]`,
      );
    }

    const reviewOverlaps = overlapsFromReviewTags(reviews ?? []);
    console.log(`\n【已分类评论实况】跨父类撞名/近义：${reviewOverlaps.length} 组（含命中条数）`);
    let totalHits = 0;
    for (const o of reviewOverlaps) {
      totalHits += o.reviewHits;
      console.log(
        `  - ${o.parentALabel}/${o.subALabel} (${o.countA}条) ↔ ${o.parentBLabel}/${o.subBLabel} (${o.countB}条) [${o.reason}]`,
      );
    }

    const affectedIds = new Set();
    for (const o of reviewOverlaps) {
      for (const r of reviews ?? []) {
        for (const t of r.ai_tags ?? []) {
          if (!t?.subKey) continue;
          if (
            (t.key === o.parentA && t.subKey === o.subA) ||
            (t.key === o.parentB && t.subKey === o.subB)
          ) {
            affectedIds.add(r.id);
          }
        }
      }
    }
    // taxonomy 设计撞名但评论实况未体现时，也计入 remap 范围
    for (const o of taxonomyOverlaps) {
      for (const r of reviews ?? []) {
        for (const t of r.ai_tags ?? []) {
          if (!t?.subKey) continue;
          if (
            (t.key === o.parentA && t.subKey === o.subA) ||
            (t.key === o.parentB && t.subKey === o.subB)
          ) {
            affectedIds.add(r.id);
          }
        }
      }
    }

    console.log(`\n  涉及评论（去重）：${affectedIds.size} / ${reviews?.length ?? 0} 条已分类`);
    console.log(`  若 taxonomy 修订后 remap subLabel：0 次 LLM，确定性改写标签`);
    console.log(`  若全量重分类：${reviews?.length ?? 0} 次 LLM 调用（通常不必）`);
    console.log(`  若仅重跑涉及组：${affectedIds.size} 次 LLM 调用\n`);
  }
}

function countTagSub(reviews, parentKey, subKey) {
  let n = 0;
  for (const r of reviews) {
    for (const t of r.ai_tags ?? []) {
      if (t?.key === parentKey && t?.subKey === subKey) {
        n++;
        break;
      }
    }
  }
  return n;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
