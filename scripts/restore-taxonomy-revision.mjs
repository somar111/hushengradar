#!/usr/bin/env node
/**
 * 从 taxonomy_revisions 快照恢复 apps.seed_categories（及 version / revisedAt）。
 *
 *   node --env-file=.env.local scripts/restore-taxonomy-revision.mjs <app> <version>           # 预览
 *   node --env-file=.env.local scripts/restore-taxonomy-revision.mjs <app> <version> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { sanitizeTaxonomy } from "../lib/taxonomy.mjs";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
);

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

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const args = argv.filter((a) => !a.startsWith("--"));
  const [appArg, versionArg] = args;
  if (!appArg || !versionArg) {
    console.error("用法：restore-taxonomy-revision.mjs <app> <version> [--apply]");
    process.exit(1);
  }
  const version = Number(versionArg);
  if (!Number.isFinite(version)) throw new Error("version 须为数字");

  const app = await resolveApp(appArg);
  const { data: rev, error } = await supabase
    .from("taxonomy_revisions")
    .select("version, kind, taxonomy, created_at")
    .eq("app_id", app.id)
    .eq("version", version)
    .single();
  if (error) throw error;

  const taxonomy = sanitizeTaxonomy(rev.taxonomy);
  const currentVersion = app.taxonomy_meta?.version ?? 0;
  const meta = {
    ...(app.taxonomy_meta ?? {}),
    version,
    revisedAt: rev.created_at,
  };

  console.log(`App: ${app.display_name}`);
  console.log(`恢复 v${version}（${rev.kind}，${rev.created_at}）← 当前 v${currentVersion}`);
  console.log(`顶层类 ${taxonomy.length} 个`);

  if (!apply) {
    console.log("\n预览模式。确认后加 --apply");
    return;
  }

  const { error: upErr } = await supabase
    .from("apps")
    .update({
      seed_categories: taxonomy,
      taxonomy_meta: meta,
      pending_reclassify: null,
    })
    .eq("id", app.id);
  if (upErr) throw upErr;
  console.log("已写库：seed_categories + taxonomy_meta，pending_reclassify 已清空");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
