// 补译：扫描所有 App 下「从未翻译」或「已标记但缺必需译文」的评论，走统一翻译管线。
//
// 用法：
//   node scripts/retranslate-incomplete.mjs              # 全部 App
//   node scripts/retranslate-incomplete.mjs <appId|external_id|名称片段>
import { createClient } from "@supabase/supabase-js";
import {
  fetchAllRows,
  listReviewsNeedingTranslation,
  persistTranslationResult,
  translateReviewWithPipeline,
} from "../lib/translateReview.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error("缺少 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEEPSEEK_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function resolveApps(arg) {
  const { data: all, error } = await supabase.from("apps").select("*").order("created_at");
  if (error) throw error;
  if (!arg) return all ?? [];
  const { data: byId } = await supabase.from("apps").select("*").eq("id", arg).maybeSingle();
  if (byId) return [byId];
  const { data: byExt } = await supabase.from("apps").select("*").eq("external_id", arg).maybeSingle();
  if (byExt) return [byExt];
  const q = arg.toLowerCase();
  const matches = (all ?? []).filter(
    (a) => a.display_name?.toLowerCase().includes(q) || a.external_id?.toLowerCase().includes(q),
  );
  if (matches.length === 1) return matches;
  if (matches.length > 1) throw new Error(`「${arg}」匹配多个 App`);
  throw new Error(`找不到 App：${arg}`);
}

async function runConcurrent(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function processApp(app) {
  const pending = await listReviewsNeedingTranslation(supabase, app.id);
  if (!pending.length) {
    console.log(`[${app.display_name}] 无需补译`);
    return { ok: 0, incomplete: 0, failed: 0 };
  }
  console.log(`[${app.display_name}] 待补译 ${pending.length} 条`);
  let ok = 0;
  let incomplete = 0;
  let failed = 0;
  await runConcurrent(pending, 8, async (r) => {
    try {
      const result = await translateReviewWithPipeline(DEEPSEEK_API_KEY, r.content, {
        appContext: app.context,
        displayName: app.display_name,
        terminologyGlossary: app.terminology_glossary ?? [],
      });
      const saved = await persistTranslationResult(supabase, r.id, result);
      if (saved.ok) ok++;
      else incomplete++;
    } catch (e) {
      failed++;
      console.error(`  失败 id=${r.id}:`, e.message);
    }
  });
  console.log(`[${app.display_name}] 完成 ok=${ok} incomplete=${incomplete} failed=${failed}`);
  return { ok, incomplete, failed };
}

async function main() {
  const appArg = process.argv[2];
  const apps = await resolveApps(appArg);
  let totalOk = 0;
  let totalIncomplete = 0;
  let totalFailed = 0;
  for (const app of apps) {
    const r = await processApp(app);
    totalOk += r.ok;
    totalIncomplete += r.incomplete;
    totalFailed += r.failed;
  }
  console.log(`\n合计：成功 ${totalOk}，仍不完整 ${totalIncomplete}，失败 ${totalFailed}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
