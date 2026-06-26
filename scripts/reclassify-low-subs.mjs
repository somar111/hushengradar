// 定向重分类：某母类下命中量低于阈值的子问题（默认 < SUBTAG_REUSE_MIN_COUNT）下的评论。
//
// 用法：
//   node --env-file=.env.local scripts/reclassify-low-subs.mjs com.levelinfinite.sgameGlobal --parent feature_request
//   node --env-file=.env.local scripts/reclassify-low-subs.mjs <app> --parent feature_request --max-count 4 --reset-only
//   node --env-file=.env.local scripts/reclassify-low-subs.mjs <app> --parent feature_request --dry-run
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { countSubTagsInReviews, SUBTAG_REUSE_MIN_COUNT } from "../lib/promptKit.mjs";
import { resetReviewsForSubReclassify } from "../lib/taxonomy.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAllRows(query, pageSize = 1000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function resolveApp(arg) {
  const { data: byId } = await supabase.from("apps").select("*").eq("id", arg).maybeSingle();
  if (byId) return byId;
  const { data: byExt } = await supabase.from("apps").select("*").eq("external_id", arg).maybeSingle();
  if (byExt) return byExt;
  const { data: all, error } = await supabase.from("apps").select("*");
  if (error) throw error;
  const q = arg.toLowerCase();
  const matches = (all ?? []).filter(
    (a) => a.display_name?.toLowerCase().includes(q) || a.external_id?.toLowerCase().includes(q),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`「${arg}」匹配多个 App`);
  throw new Error(`找不到 App：${arg}`);
}

function runCron(appKey, { skipFetch = false } = {}) {
  const cronPath = join(dirname(fileURLToPath(import.meta.url)), "cron-fetch.mjs");
  const args = skipFetch ? [cronPath, appKey, "--skip-fetch"] : [cronPath, appKey];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cron-fetch 退出码 ${code}`))));
  });
}

function parseArg(argv, name, fallback = null) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  return fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const resetOnly = argv.includes("--reset-only");
  const dryRun = argv.includes("--dry-run");
  const skipFetch = argv.includes("--skip-fetch");
  const parentKey = parseArg(argv, "--parent");
  const maxCountRaw = parseArg(argv, "--max-count", String(SUBTAG_REUSE_MIN_COUNT - 1));
  const maxCount = Number(maxCountRaw);
  const appArg = argv.find((a) => !a.startsWith("--") && a !== parentKey && a !== maxCountRaw);

  if (!appArg || !parentKey || !Number.isFinite(maxCount)) {
    console.error(
      "用法：node scripts/reclassify-low-subs.mjs <appId|external_id> --parent <key> [--max-count N] [--reset-only] [--dry-run]",
    );
    process.exit(1);
  }

  const app = await resolveApp(appArg);
  console.log(`App: ${app.display_name} (${app.id})`);
  console.log(`母类：${parentKey}，子问题命中 ≤ ${maxCount}`);

  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null),
  );
  const counts = countSubTagsInReviews(reviews);
  const byParent = counts.get(parentKey);
  if (!byParent?.size) {
    console.log("该母类下没有子问题命中，无需处理。");
    return;
  }

  const lowSubs = [...byParent.entries()]
    .filter(([, v]) => v.count <= maxCount)
    .sort((a, b) => a[1].count - b[1].count || a[0].localeCompare(b[0]));
  if (!lowSubs.length) {
    console.log("没有低于阈值的子问题。");
    return;
  }

  console.log(`低命中子问题 ${lowSubs.length} 个：`);
  for (const [subKey, { label, count }] of lowSubs) {
    console.log(`  - ${subKey}(${label}) × ${count}`);
  }

  const subKeys = lowSubs.map(([k]) => k);
  const affected = reviews.filter((r) =>
    (r.ai_tags ?? []).some((t) => t.key === parentKey && t.subKey && subKeys.includes(t.subKey)),
  ).length;
  console.log(`将重置并重分类 ${affected} 条评论。`);

  if (dryRun) return;

  const reset = await resetReviewsForSubReclassify({ supabase, app, parentKey, subKeys });
  console.log(`已重置 ${reset} 条评论。`);

  if (resetOnly) {
    console.log(" --reset-only：稍后执行 node scripts/cron-fetch.mjs", app.external_id || app.id);
    return;
  }
  if (!DEEPSEEK_API_KEY) throw new Error("重分类需要 DEEPSEEK_API_KEY");
  console.log("\n开始 cron-fetch（分类 + 翻译 + 摘要）…");
  await runCron(app.external_id || app.id, { skipFetch });
}

main().catch((e) => { console.error(e); process.exit(1); });
