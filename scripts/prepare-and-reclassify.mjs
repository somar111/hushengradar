// P0 准备 + 定向 reclassify：为 HOK（或任意 App）补 taxonomy intent，并重跑指定母类。
//
// 用法：
//   node scripts/prepare-and-reclassify.mjs com.levelinfinite.sgameGlobal --keys content_features,feature_request
//   node scripts/prepare-and-reclassify.mjs <app> --keys ... --reset-only   # 只重置，不跑 cron
//   node scripts/prepare-and-reclassify.mjs <app> --keys ... --skip-enrich  # 跳过 intent 补全
//   node scripts/prepare-and-reclassify.mjs <app> --keys ... --force-enrich  # 强制刷新 intent + feature_request subs（P0.5）
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import { createDeepSeekCaller } from "../lib/deepseek.mjs";
import { enrichFeatureRequestSubs, enrichTaxonomyIntents } from "../lib/taxonomyEnrich.mjs";
import { resetReviewsForReclassify } from "../lib/taxonomy.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

function runCron(appKey) {
  const cronPath = join(dirname(fileURLToPath(import.meta.url)), "cron-fetch.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cronPath, appKey], { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`cron-fetch 退出码 ${code}`))));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const resetOnly = argv.includes("--reset-only");
  const skipEnrich = argv.includes("--skip-enrich");
  const forceEnrich = argv.includes("--force-enrich");
  const keysArg = argv.find((a) => a.startsWith("--keys="))?.slice("--keys=".length)
    ?? (argv.includes("--keys") ? argv[argv.indexOf("--keys") + 1] : null);
  const appArg = argv.find((a) => !a.startsWith("--") && a !== keysArg);

  if (!appArg || !keysArg) {
    console.error("用法：node scripts/prepare-and-reclassify.mjs <appId|external_id> --keys key1,key2 [--reset-only] [--skip-enrich] [--force-enrich]");
    process.exit(1);
  }

  const affectedKeys = keysArg.split(",").map((k) => k.trim()).filter(Boolean);
  let app = await resolveApp(appArg);
  console.log(`App: ${app.display_name} (${app.id})`);
  console.log(`定向母类：${affectedKeys.join("、")}`);

  if (!skipEnrich) {
    if (!DEEPSEEK_API_KEY) throw new Error("补 intent 需要 DEEPSEEK_API_KEY");
    const callModel = createDeepSeekCaller(DEEPSEEK_API_KEY, { temperature: 0.3 });
    app = await enrichTaxonomyIntents({ supabase, app, callModel, force: forceEnrich });
    app = await enrichFeatureRequestSubs({ supabase, app, callModel, force: forceEnrich });
  }

  const reset = await resetReviewsForReclassify({ supabase, app, scope: "incremental", affectedKeys });
  console.log(`已重置 ${reset} 条评论（incremental: ${affectedKeys.join("、")}）`);

  if (resetOnly) {
    console.log(" --reset-only：稍后执行 node scripts/cron-fetch.mjs", app.external_id || app.id);
    return;
  }
  if (!DEEPSEEK_API_KEY) throw new Error("重分类需要 DEEPSEEK_API_KEY");
  console.log("\n开始 cron-fetch（P0+P1 分类 + 翻译 + 摘要）…");
  await runCron(app.external_id || app.id);
}

main().catch((e) => { console.error(e); process.exit(1); });
