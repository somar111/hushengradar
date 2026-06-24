// taxonomy 的手动触发器——和每日 cron 走的是同一条代码路径（lib/taxonomy.runTaxonomyStage），
// 不再是另一份独立逻辑。判断与措辞由 AI 产出，本脚本只负责"强制现在跑一次"。
//   - 还没有成形 taxonomy → 从样本设计初始体系（bootstrap）
//   - 已有体系 → 基于实时标签分布重新评估并产出修订（revise）
// 用法：
//   node scripts/build-taxonomy.mjs [appId|external_id|名称片段]
//   node scripts/build-taxonomy.mjs <...> --dry-run   # 只看 AI 会怎么改，不写库
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

  const callModel = createDeepSeekCaller(DEEPSEEK_API_KEY, { temperature: 0.3 });
  const report = await runTaxonomyStage({ supabase, app, callModel, options: { force: true, dryRun } });

  if (report.action === "none") {
    console.log(`\n结论：无需修订（${report.reason ?? report.verdict ?? ""}）`);
    return;
  }
  if (report.pendingReclassify) {
    console.log(`\n已产出破坏性修订提案（${report.pendingReclassify.scope}），写入 apps.pending_reclassify。`);
    console.log("确认后执行：node scripts/reclassify-app.mjs", app.external_id || app.id);
  } else if (report.action === "revise") {
    console.log(`\n修订完成：版本 v${report.version}，确定性 remap 改写 ${report.remapped ?? 0} 条评论标签。`);
  } else if (report.action === "bootstrap") {
    console.log(`\nbootstrap 完成：版本 v${report.version}。`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
