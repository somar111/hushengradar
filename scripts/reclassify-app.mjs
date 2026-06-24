// 重置指定 App 的全部 AI 分类结果，并只对该 App 跑 cron-fetch（抓取+分类+翻译+摘要）。
// 通用：node scripts/reclassify-app.mjs <appId|external_id|名称片段>
// 仅重置、不跑 cron：node scripts/reclassify-app.mjs <...> --reset-only
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createClient } from "@supabase/supabase-js";

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

async function resetClassification(app) {
  const { count: classified, error: countErr } = await supabase
    .from("reviews")
    .select("*", { count: "exact", head: true })
    .eq("app_id", app.id)
    .not("ai_classified_at", "is", null);
  if (countErr) throw countErr;

  const { count: total, error: totalErr } = await supabase
    .from("reviews")
    .select("*", { count: "exact", head: true })
    .eq("app_id", app.id);
  if (totalErr) throw totalErr;

  console.log(`将重置 ${app.display_name}：共 ${total ?? 0} 条评论，其中已分类 ${classified ?? 0} 条`);

  const { error: updErr } = await supabase
    .from("reviews")
    .update({ ai_tags: [], ai_tag_keys: [], ai_classified_at: null })
    .eq("app_id", app.id);
  if (updErr) throw updErr;

  const { error: sumErr } = await supabase.from("tag_summaries").delete().eq("app_id", app.id);
  if (sumErr) throw sumErr;

  console.log("已清空 ai_tags / ai_classified_at 与 tag_summaries。");
}

function runCronForApp(appKey) {
  const cronPath = join(dirname(fileURLToPath(import.meta.url)), "cron-fetch.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cronPath, appKey], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`cron-fetch 退出码 ${code}`));
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const resetOnly = argv.includes("--reset-only");
  const appArg = argv.find((a) => !a.startsWith("--"));
  if (!appArg) {
    console.error("用法：node scripts/reclassify-app.mjs <appId|external_id|名称片段> [--reset-only]");
    process.exit(1);
  }

  const app = await resolveApp(appArg);
  console.log(`App: ${app.display_name} (${app.id})`);

  await resetClassification(app);
  if (resetOnly) {
    console.log("--reset-only：未启动 cron-fetch。可稍后执行：node scripts/cron-fetch.mjs", app.external_id || app.id);
    return;
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("重分类需要 DEEPSEEK_API_KEY");
  }

  console.log("\n开始对该 App 跑 cron-fetch（抓取 + 分类 + 翻译 + 摘要）…");
  await runCronForApp(app.external_id || app.id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
