#!/usr/bin/env node
/**
 * 定向 remap：把误挂在某父类下的 sub 迁到正确父类（0 次 LLM）。
 *
 *   node --env-file=.env.local scripts/remap-cross-parent-sub.mjs <app> \
 *     --from=ui_ux_regression --to=app_bugs_and_crashes --sub=ui_issue [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import { applyRemapToTags } from "../lib/taxonomy.mjs";
import { aiTagKeysFromTags } from "../lib/promptKit.mjs";

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
  throw new Error(`找不到 App：${arg}`);
}

function readFlag(argv, name) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

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

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const appArg = argv.find((a) => !a.startsWith("--") && !a.includes("="));
  const fromKey = readFlag(argv, "--from");
  const toKey = readFlag(argv, "--to");
  const subKey = readFlag(argv, "--sub");
  if (!appArg || !fromKey || !toKey || !subKey) {
    console.error(
      "用法：remap-cross-parent-sub.mjs <app> --from=<parent> --to=<parent> --sub=<subKey> [--apply]",
    );
    process.exit(1);
  }

  const app = await resolveApp(appArg);
  const toParent = (app.seed_categories ?? []).find((c) => c.key === toKey);
  const toSub = toParent?.subcategories?.find((s) => s.key === subKey);
  if (!toParent || !toSub) {
    throw new Error(`目标不存在：${toKey}/${subKey}`);
  }

  const remaps = [
    {
      match: { key: fromKey, subKey },
      set: {
        key: toKey,
        subKey,
        label: toParent.label,
        subLabel: toSub.label,
      },
      reason: "cross-parent misroute remap",
    },
  ];

  const reviews = await fetchAllRows(
    supabase
      .from("reviews")
      .select("id, ai_tags")
      .eq("app_id", app.id)
      .not("ai_classified_at", "is", null),
  );

  const updates = [];
  for (const r of reviews) {
    if (!(r.ai_tags ?? []).some((t) => t.key === fromKey && t.subKey === subKey)) continue;
    const { tags, changed } = applyRemapToTags(r.ai_tags, remaps);
    if (changed) updates.push({ id: r.id, ai_tags: tags, ai_tag_keys: aiTagKeysFromTags(tags) });
  }

  console.log(`App: ${app.display_name}`);
  console.log(`remap ${fromKey}/${subKey} → ${toKey}/${subKey}（${toSub.label}）`);
  console.log(`命中 ${updates.length} 条评论`);

  if (!updates.length) {
    console.log("无需改写");
    return;
  }

  if (!apply) {
    console.log("预览模式。确认后加 --apply");
    return;
  }

  for (let i = 0; i < updates.length; i += 200) {
    const batch = updates.slice(i, i + 200);
    await Promise.all(
      batch.map((u) =>
        supabase
          .from("reviews")
          .update({ ai_tags: u.ai_tags, ai_tag_keys: u.ai_tag_keys })
          .eq("id", u.id)
          .then(({ error }) => {
            if (error) throw error;
          }),
      ),
    );
  }
  console.log(`已写库 ${updates.length} 条`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
