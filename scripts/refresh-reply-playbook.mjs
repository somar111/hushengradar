#!/usr/bin/env node
// 刷新指定 App（或全部）的 reply_playbook。输入变更检测与 cron 共用 ensureReplyPlaybookFresh。

import { createClient } from "@supabase/supabase-js";
import { ensureReplyPlaybookFresh, refreshReplyPlaybook } from "../lib/replyPlaybook.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("缺少 Supabase 环境变量");
  process.exit(1);
}
if (!apiKey) {
  console.error("缺少 DEEPSEEK_API_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const appArg = argv.find((a) => !a.startsWith("--"));

const { data: apps, error } = await supabase.from("apps").select("*");
if (error) throw error;

let targets = apps ?? [];
if (appArg) {
  targets = targets.filter(
    (a) =>
      a.id === appArg ||
      a.external_id === appArg ||
      a.display_name?.toLowerCase().includes(appArg.toLowerCase())
  );
}
if (!targets.length) {
  console.error("未找到 App");
  process.exit(1);
}

for (const app of targets) {
  const result = force
    ? await refreshReplyPlaybook({ supabase, app, apiKey, force: true })
    : await ensureReplyPlaybookFresh({ supabase, app, apiKey, logger: console });
  console.log(
    `${app.display_name}: ${result.refreshed ? "已刷新" : "已是最新"} (${(result.playbook ?? "").slice(0, 60)}…)`,
  );
}
