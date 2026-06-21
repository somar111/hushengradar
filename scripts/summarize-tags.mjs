// 一次性脚本：给每个分类标签生成真实摘要句，写入 tag_summaries 表。
// 以后接 Cron 增量抓取后，应该在每次重新分类完触发同一逻辑（这里先按需手动跑）。
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;
const SAMPLE_SIZE = 40;

async function summarizeCluster(tagLabel, sampleContents, appContext) {
  const systemPrompt = [
    `下面是一批被归类为"${tagLabel}"的应用商店评论样本。`,
    "请用一句简短中文短语概括这些评论具体在说什么（比如具体哪个功能、哪个机制、哪类场景），要紧贴样本内容，不要泛泛而谈，不要编造样本里没有的细节。",
    "输出的短语要能直接接在「N 条评论」后面组成完整句子，比如「提到更新后频繁出现保存失败、文件丢失」——不要重复「评论」「条」这些字，不要加引号或多余前后缀，不要输出数字统计。",
    `这款 App 的背景信息：${appContext}`,
  ].join("\n");
  const userPrompt = sampleContents.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function sampleDiverse(items, n) {
  // 打散顺序再取前 n 条，避免摘要只看到某一种语言/评分的样本
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

async function main() {
  const { data: app, error: appErr } = await supabase
    .from("apps")
    .select("*")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (appErr) throw appErr;
  console.log("app:", app.display_name, app.id);

  const { data: reviews, error } = await supabase
    .from("reviews")
    .select("content, ai_tags")
    .eq("app_id", app.id);
  if (error) throw error;
  console.log("总评论数:", reviews.length);

  const byTag = {};
  for (const r of reviews) {
    for (const t of r.ai_tags ?? []) {
      if (!byTag[t.key]) byTag[t.key] = { label: t.label, contents: [] };
      byTag[t.key].contents.push(r.content);
    }
  }

  console.log("标签数:", Object.keys(byTag).length);
  for (const [key, { label, contents }] of Object.entries(byTag)) {
    const sample = sampleDiverse(contents, SAMPLE_SIZE);
    console.log(`生成摘要：${key}（${label}），样本 ${sample.length}/${contents.length}`);
    const summary = await summarizeCluster(label, sample, app.context);
    const { error: upsertErr } = await supabase.from("tag_summaries").upsert(
      {
        app_id: app.id,
        tag_key: key,
        summary,
        sample_size: sample.length,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "app_id,tag_key" }
    );
    if (upsertErr) throw upsertErr;
    console.log("  =>", summary);
  }

  console.log("完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
