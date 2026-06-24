// 把评论里已稳定出现的 subTag 写回 apps.seed_categories（只追加，不删改已有项）。
// taxonomy 是可修订数据：跑完一批分类、人工看过子问题分布后，用此脚本把反复出现的子问题
// 固化进 taxonomy，下次分类会优先复用。
// 用法：node scripts/merge-observed-subtags.mjs [appId] [--min 5]
import { createClient } from "@supabase/supabase-js";
import { SUBTAG_REUSE_MIN_COUNT, mergeObservedSubTagsIntoTaxonomy } from "../lib/promptKit.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAll(query) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return all;
}

function parseArgs(argv) {
  let minCount = SUBTAG_REUSE_MIN_COUNT;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--min") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--min 必须是正整数");
      minCount = n;
    } else {
      pos.push(argv[i]);
    }
  }
  return { appId: pos[0], minCount };
}

async function main() {
  const { appId, minCount } = parseArgs(process.argv.slice(2));

  const { data: app, error: appErr } = appId
    ? await supabase.from("apps").select("*").eq("id", appId).single()
    : await supabase.from("apps").select("*").order("created_at").limit(1).single();
  if (appErr) throw appErr;
  console.log(`App: ${app.display_name} (${app.id})，稳定阈值 >= ${minCount} 次`);

  const classified = await fetchAll(
    supabase.from("reviews").select("ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const { taxonomy, added } = mergeObservedSubTagsIntoTaxonomy(app.seed_categories ?? [], classified, minCount);
  if (!added) {
    console.log("没有新的子问题需要写入 taxonomy。");
    return;
  }

  const { error } = await supabase.from("apps").update({ seed_categories: taxonomy }).eq("id", app.id);
  if (error) throw error;

  console.log(`已追加 ${added} 个子问题到 apps.seed_categories。`);
  for (const c of taxonomy) {
    if (!c.subcategories?.length) continue;
    console.log(`- ${c.key}(${c.label})`);
    console.log(`    ${c.subcategories.map((s) => `${s.key}(${s.label})`).join("、")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
