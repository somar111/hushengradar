// 从一个 App 的真实评论样本，设计出它专属的「问题分类体系」（顶层类型 + 各自子问题），写回
// apps.seed_categories。taxonomy 是可修订数据，不限于接入时定一次：
//   - 全量重设计：node scripts/build-taxonomy.mjs [appId]
//   - 增量固化稳定子问题：node scripts/merge-observed-subtags.mjs [appId] [--min 5]
// 通用：任何 App 均可运行，不针对任何具体产品。
import { createClient } from "@supabase/supabase-js";
import { buildTaxonomyPrompt, sanitizeTagKey } from "../lib/promptKit.mjs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEEPSEEK_API_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const SAMPLE_SIZE = 250;

async function fetchAll(query) {
  const all = []; let from = 0;
  while (true) {
    const { data, error } = await query.range(from, from + 999);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return all;
}

// 均匀抽样：把数组按步长均匀取 n 个，比纯随机更稳定地覆盖整个时间跨度/内容分布
function spread(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  return Array.from({ length: n }, (_, i) => arr[Math.floor(i * step)]);
}

async function main() {
  const appId = process.argv[2];
  const { data: app, error: appErr } = appId
    ? await supabase.from("apps").select("*").eq("id", appId).single()
    : await supabase.from("apps").select("*").order("created_at").limit(1).single();
  if (appErr) throw appErr;
  console.log(`App: ${app.display_name} (${app.id})`);

  const rows = await fetchAll(
    supabase.from("reviews").select("content, rating").eq("app_id", app.id)
  );
  // 问题分类体系是为"问题"服务的，差评里问题信号最密集——优先从 rating<=3 抽样，不够再用其余补足
  const problems = rows.filter((r) => (r.rating ?? 5) <= 3 && r.content?.trim());
  const others = rows.filter((r) => (r.rating ?? 5) > 3 && r.content?.trim());
  const sample = [...spread(problems, SAMPLE_SIZE), ...spread(others, Math.max(0, SAMPLE_SIZE - problems.length))].slice(0, SAMPLE_SIZE);
  console.log(`总评论 ${rows.length}，抽样 ${sample.length} 条（其中差评 ${Math.min(problems.length, SAMPLE_SIZE)} 条）喂给AI设计体系`);

  const sampleText = sample.map((r, i) => `${i + 1}. [${r.rating}★] ${r.content.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
  const userPrompt = `这款App的背景信息：${app.context || "（无）"}\n\n真实用户评论样本：\n${sampleText}`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: buildTaxonomyPrompt() }, { role: "user", content: userPrompt }],
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek设计体系失败 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!Array.isArray(parsed.categories)) throw new Error("AI返回的 categories 不是数组");

  const taxonomy = parsed.categories
    .filter((c) => c && c.key && c.label)
    .map((c) => ({
      key: sanitizeTagKey(c.key),
      label: c.label,
      subcategories: Array.isArray(c.subcategories)
        ? c.subcategories.filter((s) => s && s.key && s.label).map((s) => ({ key: sanitizeTagKey(s.key), label: s.label }))
        : [],
    }));

  console.log("\n设计出的分类体系：");
  for (const c of taxonomy) {
    console.log(`- ${c.key}(${c.label})`);
    console.log(`    ${c.subcategories.map((s) => `${s.key}(${s.label})`).join("、") || "（无子问题）"}`);
  }

  const { error } = await supabase.from("apps").update({ seed_categories: taxonomy }).eq("id", app.id);
  if (error) throw error;
  console.log("\n已写入 apps.seed_categories。下次重新分类会按这套体系归类。");
}

main().catch((e) => { console.error(e); process.exit(1); });
