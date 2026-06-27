/** 对比 Top 反馈内存计数 vs 列表 SQL 计数，诊断 tag 条数偏差 */
import { createClient } from "@supabase/supabase-js";
import { topLevelTagKeysForReview, aiTagKeysFromTags } from "../lib/promptKit.mjs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) throw new Error("需要 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");

const supabase = createClient(url, key);
const TAG = process.argv[2] || "matchmaking";
const appIdArg = process.argv.find((a) => a.startsWith("--app-id="))?.slice("--app-id=".length);

async function fetchAll(query) {
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function main() {
  let appQ = supabase.from("apps").select("id, display_name").order("created_at").limit(1);
  if (appIdArg) appQ = supabase.from("apps").select("id, display_name").eq("id", appIdArg).single();
  const { data: app, error: appErr } = await appQ;
  if (appErr) throw appErr;
  const appRow = Array.isArray(app) ? app[0] : app;
  if (!appRow) throw new Error("未找到 App");

  const { data: latest } = await supabase
    .from("reviews")
    .select("review_date")
    .eq("app_id", appRow.id)
    .order("review_date", { ascending: false })
    .limit(1);
  const anchor = latest?.[0]?.review_date ? new Date(latest[0].review_date) : new Date();
  const since = new Date(anchor.getTime() - 30 * 86400000).toISOString();

  const rows = await fetchAll(
    supabase
      .from("reviews")
      .select("id, ai_tags, ai_tag_keys, review_date")
      .eq("app_id", appRow.id)
      .gte("review_date", since),
  );

  let memoryCount = 0;
  let keysNullWithTag = 0;
  for (const r of rows) {
    if (topLevelTagKeysForReview(r).includes(TAG)) memoryCount++;
    const fromTags = aiTagKeysFromTags(r.ai_tags);
    if (fromTags.includes(TAG)) {
      const keys = r.ai_tag_keys;
      if (!Array.isArray(keys) || !keys.includes(TAG)) keysNullWithTag++;
    }
  }

  const base = supabase.from("reviews").select("*", { count: "exact", head: true }).eq("app_id", appRow.id).gte("review_date", since);
  const [{ count: sqlKeys }, { count: sqlTags }] = await Promise.all([
    base.contains("ai_tag_keys", [TAG]),
    base.contains("ai_tags", JSON.stringify([{ key: TAG }])),
  ]);

  console.log(`App: ${appRow.display_name} (${appRow.id})`);
  console.log(`Tag: ${TAG}, since: ${since.slice(0, 10)}`);
  console.log(`内存聚合 (Top 反馈): ${memoryCount}`);
  console.log(`SQL ai_tag_keys (旧列表/Ask): ${sqlKeys}`);
  console.log(`SQL ai_tags (修复后): ${sqlTags}`);
  console.log(`ai_tags 有标但 ai_tag_keys 缺/不同步: ${keysNullWithTag}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
