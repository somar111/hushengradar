// 执行"破坏性重分类"——taxonomy 修订里需重读评论才能落地的那部分（apps.pending_reclassify）。
// 这是产品里唯一需要人工确认的破坏性动作（其余非破坏性修订由管线自动应用）。
//
// 默认按 pending_reclassify 的 scope 走（通常是 incremental：只重置受影响评论，省 API 额度）：
//   node scripts/reclassify-app.mjs <appId|external_id|名称片段>
// 强制全量重分类（清空该 App 全部分类后重跑，忽略 pending 的增量范围）：
//   node scripts/reclassify-app.mjs <...> --full
// 定向重分类（只重置命中指定顶层 key 的评论）：
//   node scripts/reclassify-app.mjs <...> --keys content_features,feature_request
// 只重置、不跑 cron：
//   node scripts/reclassify-app.mjs <...> --reset-only
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";
import { resetReviewsForReclassify } from "../lib/taxonomy.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY");
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
    (a) => a.display_name?.toLowerCase().includes(q) || a.external_id?.toLowerCase().includes(q)
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`「${arg}」匹配到多个 App：${matches.map((a) => a.display_name).join("、")}，请传 id 或 external_id`);
  }
  throw new Error(`找不到 App：${arg}`);
}

function runCronForApp(appKey) {
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
  const forceFull = argv.includes("--full");
  const keysArg = argv.find((a) => a.startsWith("--keys="))?.slice("--keys=".length)
    ?? (argv.includes("--keys") ? argv[argv.indexOf("--keys") + 1] : null);
  const appArg = argv.find((a) => !a.startsWith("--") && a !== keysArg);
  if (!appArg) {
    console.error("用法：node scripts/reclassify-app.mjs <appId|external_id|名称片段> [--full] [--reset-only]");
    process.exit(1);
  }

  const app = await resolveApp(appArg);
  console.log(`App: ${app.display_name} (${app.id})`);

  const pending = app.pending_reclassify ?? null;
  let scope = "full";
  let affectedKeys = [];
  if (keysArg) {
    scope = "incremental";
    affectedKeys = keysArg.split(",").map((k) => k.trim()).filter(Boolean);
    console.log(`--keys：定向重分类 ${affectedKeys.join("、")}`);
  } else if (!forceFull && pending) {
    scope = pending.scope ?? "incremental";
    affectedKeys = pending.affectedKeys ?? [];
    console.log(`按待确认提案执行（v${pending.fromVersion}→v${pending.toVersion}，${scope}）：${pending.reason ?? ""}`);
    if (affectedKeys.length) console.log(`受影响顶层 key：${affectedKeys.join("、")}`);
  } else if (!pending && !forceFull) {
    console.log("没有待确认的 pending_reclassify，按全量重分类处理（可用 --full 显式声明）。");
  } else if (forceFull) {
    console.log("--full：强制全量重分类，忽略 pending 的增量范围。");
  }

  const reset = await resetReviewsForReclassify({ supabase, app, scope, affectedKeys });
  console.log(`已重置 ${reset} 条评论的分类（${scope}）。`);

  // 受影响评论的旧标签摘要会随重分类刷新；增量场景下 tag_summaries 由 cron 末尾按全量重算覆盖
  if (scope === "full") {
    const { error } = await supabase.from("tag_summaries").delete().eq("app_id", app.id);
    if (error) throw error;
    console.log("已清空 tag_summaries（全量场景）。");
  }

  // 消费掉 pending（已落地）
  if (pending && !resetOnly) {
    const { error } = await supabase.from("apps").update({ pending_reclassify: null }).eq("id", app.id);
    if (error) throw error;
  }

  if (resetOnly) {
    console.log("--reset-only：未启动 cron-fetch。稍后执行：node scripts/cron-fetch.mjs", app.external_id || app.id);
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("重分类需要 DEEPSEEK_API_KEY");

  console.log("\n开始对该 App 跑 cron-fetch（抓取 + 分类 + 翻译 + 摘要）…");
  await runCronForApp(app.external_id || app.id);
}

main().catch((e) => { console.error(e); process.exit(1); });
