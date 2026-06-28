// 手动触发「其他」桶 enrich → reset → 重分类（满足 GENERAL_ENRICH_MIN_COUNT 的各父类）。
//
//   node --env-file=.env.local scripts/reclassify-general-bucket.mjs              # 全部 App
//   node --env-file=.env.local scripts/reclassify-general-bucket.mjs <app>       # 单个 App
//   node --env-file=.env.local scripts/reclassify-general-bucket.mjs --reset-only # 只 enrich+reset，不跑 cron
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";
import { GENERAL_ENRICH_MIN_COUNT } from "../lib/promptKit.mjs";
import { resetReviewsForCatchAllReclassify } from "../lib/taxonomy.mjs";
import {
  countGeneralHitsByParent,
  enrichParentFromGeneralBucket,
} from "../lib/taxonomyEnrich.mjs";
import { createDeepSeekCaller } from "../lib/deepseek.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
  if (matches.length > 1) {
    throw new Error(`「${arg}」匹配到多个 App：${matches.map((a) => a.display_name).join("、")}`);
  }
  throw new Error(`找不到 App：${arg}`);
}

function runCronSkipFetch(appKey) {
  const cronPath = join(dirname(fileURLToPath(import.meta.url)), "cron-fetch.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cronPath, appKey, "--skip-fetch"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cron-fetch 退出码 ${code}`))));
  });
}

async function processApp(app, { resetOnly }) {
  console.log(`\n=== ${app.display_name} (${app.external_id || app.id}) ===`);

  const reviews = await fetchAllRows(
    supabase.from("reviews").select("id, content, ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null),
  );
  const byParent = countGeneralHitsByParent(reviews);
  const eligible = [...byParent.entries()]
    .filter(([, n]) => n >= GENERAL_ENRICH_MIN_COUNT)
    .sort((a, b) => b[1] - a[1]);

  if (!eligible.length) {
    console.log(`无父类「其他」≥ ${GENERAL_ENRICH_MIN_COUNT}，跳过。`);
    return { reset: 0 };
  }

  console.log(
    `待处理父类 ${eligible.length} 个：${eligible.map(([k, n]) => `${k}(${n})`).join("、")}`,
  );

  if (!DEEPSEEK_API_KEY) throw new Error("需要 DEEPSEEK_API_KEY");
  const callModel = createDeepSeekCaller(DEEPSEEK_API_KEY, { temperature: 0.3 });

  let totalReset = 0;
  const resetIds = new Set();

  for (const [parentKey, generalCount] of eligible) {
    console.log(`\n[general-enrich] ${parentKey}「其他」${generalCount} 条 → enrich…`);
    const { app: nextApp, addedSubs } = await enrichParentFromGeneralBucket({
      supabase,
      app,
      callModel,
      reviews,
      parentKey,
      logger: console,
    });
    app = nextApp;
    if (addedSubs.length) {
      console.log(`  新增 sub：${addedSubs.map((s) => s.label).join("、")}`);
    } else {
      console.log("  未新增 sub，仍重置「其他」并重分类");
    }

    const reset = await resetReviewsForCatchAllReclassify({ supabase, app, parentKey });
    console.log(`  重置 ${parentKey}「其他」${reset} 条`);
    totalReset += reset;
    for (const r of reviews) {
      if ((r.ai_tags ?? []).some((t) => t.key === parentKey && (t.subKey === "general" || t.subLabel === "其他"))) {
        resetIds.add(r.id);
      }
    }
  }

  console.log(`\n${app.display_name}：enrich ${eligible.length} 个父类，去重后约 ${resetIds.size} 条评论待重分类`);

  if (resetOnly) {
    console.log("--reset-only：未启动 cron-fetch。稍后：node scripts/cron-fetch.mjs", app.external_id || app.id, "--skip-fetch");
    return { reset: resetIds.size };
  }

  console.log("开始 cron-fetch --skip-fetch…");
  await runCronSkipFetch(app.external_id || app.id);
  return { reset: resetIds.size };
}

async function main() {
  const argv = process.argv.slice(2);
  const resetOnly = argv.includes("--reset-only");
  const appArg = argv.find((a) => !a.startsWith("--"));

  let targets;
  if (appArg) {
    targets = [await resolveApp(appArg)];
  } else {
    const { data, error } = await supabase.from("apps").select("*");
    if (error) throw error;
    targets = data ?? [];
    console.log(`全部 ${targets.length} 个 App，门槛：各父类「其他」≥ ${GENERAL_ENRICH_MIN_COUNT}`);
  }

  let total = 0;
  for (const app of targets) {
    const { reset } = await processApp(app, { resetOnly });
    total += reset;
  }
  console.log(`\n完成。累计 reset 约 ${total} 条评论（跨父类可能有重复计数）。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
