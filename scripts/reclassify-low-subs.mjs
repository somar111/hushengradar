// 定向重分类：某母类下命中量低于阈值的子问题（默认 ≤ LOW_SUB_RECLASSIFY_MAX_COUNT）下的评论。
// taxonomy 设计清单里的 sub 不重置，即使命中量低。
//
// 用法：
//   node --env-file=.env.local scripts/reclassify-low-subs.mjs com.levelinfinite.sgameGlobal --parent feature_request
//   node --env-file=.env.local scripts/reclassify-low-subs.mjs <app> --parent feature_request --max-count 4 --reset-only
//   node --env-file=.env.local scripts/reclassify-low-subs.mjs <app> --parent feature_request --dry-run
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import {
  buildDesignedSubKeysByParent,
  countSubTagsInReviews,
  findLowHitSubKeys,
  LOW_SUB_RECLASSIFY_MAX_COUNT,
} from "../lib/promptKit.mjs";
import { resetLowHitSubsForReclassify, resetReviewsForSubReclassify } from "../lib/taxonomy.mjs";
import { getUniversalSubcategories } from "../lib/taxonomyEnrich.mjs";

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
  const maxCountRaw = parseArg(argv, "--max-count", String(LOW_SUB_RECLASSIFY_MAX_COUNT));
  const maxCount = Number(maxCountRaw);
  const appArg = argv.find((a) => !a.startsWith("--") && a !== parentKey && a !== maxCountRaw);

  if (!appArg || !Number.isFinite(maxCount)) {
    console.error(
      "用法：node scripts/reclassify-low-subs.mjs <appId|external_id> [--parent <key>] [--max-count N] [--reset-only] [--dry-run]",
    );
    process.exit(1);
  }

  const app = await resolveApp(appArg);
  const universalSubcategories = getUniversalSubcategories(app);
  const designed = buildDesignedSubKeysByParent(app.seed_categories ?? [], universalSubcategories);

  console.log(`App: ${app.display_name} (${app.id})`);
  console.log(`子问题命中 ≤ ${maxCount}${parentKey ? `，母类：${parentKey}` : "（全部母类）"}`);

  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null),
  );
  const lowByParent = findLowHitSubKeys(reviews, { maxCount, designedSubKeysByParent: designed });
  const parents = parentKey ? [parentKey] : [...lowByParent.keys()];

  if (parentKey && !lowByParent.has(parentKey)) {
    const byParent = countSubTagsInReviews(reviews).get(parentKey);
    if (!byParent?.size) {
      console.log("该母类下没有子问题命中，无需处理。");
      return;
    }
    console.log("没有低于阈值、且不在 taxonomy 设计清单外的子问题。");
    return;
  }

  let affected = 0;
  for (const pk of parents) {
    const subs = lowByParent.get(pk);
    if (!subs?.length) continue;
    const counts = countSubTagsInReviews(reviews).get(pk);
    console.log(`低命中子问题 ${subs.length} 个（${pk}）：`);
    for (const subKey of subs) {
      const v = counts?.get(subKey);
      console.log(`  - ${subKey}(${v?.label ?? subKey}) × ${v?.count ?? "?"}`);
    }
    affected += reviews.filter((r) =>
      (r.ai_tags ?? []).some((t) => t.key === pk && t.subKey && subs.includes(t.subKey)),
    ).length;
  }

  if (!affected) {
    console.log("没有需要重置的评论。");
    return;
  }
  console.log(`将重置并重分类 ${affected} 条评论。`);

  if (dryRun) return;

  const reset = parentKey
    ? await resetReviewsForSubReclassify({
        supabase,
        app,
        parentKey,
        subKeys: lowByParent.get(parentKey) ?? [],
      })
    : await resetLowHitSubsForReclassify({
        supabase,
        app,
        seedCategories: app.seed_categories ?? [],
        universalSubcategories,
        maxCount,
        logger: console,
      });
  console.log(`已重置 ${reset} 条评论。`);

  if (resetOnly) {
    console.log(" --reset-only：稍后执行 node scripts/cron-fetch.mjs", app.external_id || app.id, "--skip-fetch");
    return;
  }
  if (!DEEPSEEK_API_KEY) throw new Error("重分类需要 DEEPSEEK_API_KEY");
  console.log("\n开始 cron-fetch（分类 + 翻译 + 摘要）…");
  await runCron(app.external_id || app.id, { skipFetch });
}

main().catch((e) => { console.error(e); process.exit(1); });
