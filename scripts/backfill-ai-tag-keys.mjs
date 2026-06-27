/**
 * 将 reviews.ai_tag_keys 与 ai_tags 顶层 key 对齐（幂等）。
 * 展示/筛选计数已统一走 ai_tags；本脚本仅维护索引副本，便于 taxonomyEnrich 等数组筛选。
 *
 * 用法：node scripts/backfill-ai-tag-keys.mjs [--dry-run] [--app-id=<uuid>]
 */
import { createClient } from "@supabase/supabase-js";
import { aiTagKeysFromTags } from "../lib/promptKit.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dryRun = process.argv.includes("--dry-run");
const appIdArg = process.argv.find((a) => a.startsWith("--app-id="))?.slice("--app-id=".length);

const PAGE = 500;

function keysEqual(a, b) {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  if (left.length !== right.length) return false;
  return left.every((v, i) => v === right[i]);
}

async function fetchPage(from) {
  let q = supabase
    .from("reviews")
    .select("id, ai_tags, ai_tag_keys")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);
  if (appIdArg) q = q.eq("app_id", appIdArg);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

async function main() {
  let from = 0;
  let scanned = 0;
  let updated = 0;

  while (true) {
    const rows = await fetchPage(from);
    if (!rows.length) break;

    for (const row of rows) {
      scanned++;
      const expected = aiTagKeysFromTags(row.ai_tags);
      if (keysEqual(row.ai_tag_keys, expected)) continue;
      updated++;
      if (dryRun) {
        console.log(`[dry-run] ${row.id}: ${JSON.stringify(row.ai_tag_keys)} -> ${JSON.stringify(expected)}`);
        continue;
      }
      const { error } = await supabase.from("reviews").update({ ai_tag_keys: expected }).eq("id", row.id);
      if (error) throw error;
    }

    if (rows.length < PAGE) break;
    from += PAGE;
  }

  console.log(
    dryRun
      ? `[dry-run] 扫描 ${scanned} 条，需更新 ${updated} 条`
      : `完成：扫描 ${scanned} 条，已更新 ${updated} 条 ai_tag_keys`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
