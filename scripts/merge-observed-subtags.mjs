// 已并入自治的 taxonomy 修订：管线检测到"已稳定出现但还没进体系的子问题"会自动触发一次
// AI 修订，由模型在整体审视中完成固化（promote）/改名/合并——比单纯机械追加更准（顺手去重近义）。
// 本脚本保留为薄入口，等价于"现在强制跑一次修订"，与每日 cron 同一条代码路径。
// 用法：node scripts/merge-observed-subtags.mjs [appId|external_id|名称片段] [--dry-run]
import { createClient } from "@supabase/supabase-js";
import { createDeepSeekCaller } from "../lib/deepseek.mjs";
import { runTaxonomyStage } from "../lib/taxonomy.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEEPSEEK_API_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function resolveApp(arg) {
  if (!arg) {
    const { data, error } = await supabase.from("apps").select("*").order("created_at").limit(1).single();
    if (error) throw error;
    return data;
  }
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
  if (matches.length > 1) throw new Error(`「${arg}」匹配到多个 App：${matches.map((a) => a.display_name).join("、")}`);
  throw new Error(`找不到 App：${arg}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const appArg = argv.find((a) => !a.startsWith("--"));

  const app = await resolveApp(appArg);
  console.log(`App: ${app.display_name} (${app.id})${dryRun ? "　[dry-run]" : ""}`);
  console.log("提示：子问题固化已并入自治修订，这里等价于强制跑一次 taxonomy 修订。");

  const callModel = createDeepSeekCaller(DEEPSEEK_API_KEY, { temperature: 0.3 });
  const report = await runTaxonomyStage({ supabase, app, callModel, options: { force: true, dryRun } });
  console.log(`\n结果：${report.action}${report.version ? `（v${report.version}）` : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
