// 定时增量任务：循环 apps 表所有 App，抓新评论 -> 真实分类 -> 翻译 -> 刷新标签摘要。
// 通用脚本，不绑定任何具体 App；加新 App 只需要在 apps 表插一行，这个脚本自动覆盖到它。
import { createClient } from "@supabase/supabase-js";
import gplayPkg from "google-play-scraper";
import { BASELINE_CATEGORIES, buildClassifyPrompt, buildSummaryPrompt, sanitizeTagKey } from "../lib/promptKit.mjs";

const BASELINE_KEYS = new Set(BASELINE_CATEGORIES.map((c) => c.key));

const gplay = gplayPkg.default ?? gplayPkg;
const SORT_NEWEST = 2;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEEPSEEK_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_LOOKBACK_DAYS = 30; // 没有 last_fetched_at 时（新 App 第一次跑），往回抓多久
const LOCALES = [
  ["en", "us"], ["id", "id"], ["es", "mx"], ["ar", "sa"], ["pt", "br"], ["hi", "in"],
];

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function fetchReviewsSince(packageName, sinceDate, lang, country) {
  const all = [];
  let token;
  for (let page = 0; page < 40; page++) {
    const res = await gplay.reviews({
      appId: packageName, sort: SORT_NEWEST, num: 150, lang, country,
      paginate: true, nextPaginationToken: token,
    });
    if (!res.data.length) break;
    all.push(...res.data);
    const oldest = res.data[res.data.length - 1];
    if (new Date(oldest.date) < sinceDate) break;
    if (!res.nextPaginationToken) break;
    token = res.nextPaginationToken;
    await new Promise((r) => setTimeout(r, 300));
  }
  return all.filter((r) => new Date(r.date) >= sinceDate).map((r) => ({
    id: r.id, userName: r.userName, date: r.date, score: r.score,
    text: r.text ?? "", version: r.version ?? null,
    replyDate: r.replyDate ?? null, replyText: r.replyText ?? null,
  }));
}

async function classifyReview(content, rating, appContext, existingCustomTags = []) {
  const systemPrompt = buildClassifyPrompt({ appContext, existingCustomTags });

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `评分：${rating} 星\n评论内容：${content}` }],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek分类 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!Array.isArray(parsed.tags)) return [];
  return parsed.tags
    .filter((t) => t && t.key && t.label)
    .map((t) => ({ key: sanitizeTagKey(t.key), label: t.label }));
}

async function detectAndTranslate(content) {
  const systemPrompt = [
    "你是翻译助手。给你一条应用商店评论原文，请：",
    "1. 识别它真实使用的语言，输出 ISO 639-1 两位代码（如 en/zh/id/es/ar/pt/hi）。",
    "2. 如果原文不是中文，把它翻译成简体中文；如果原文已经是中文，translated_zh 填 null。",
    "3. 如果原文不是英文，把它翻译成英文；如果原文已经是英文，translated_en 填 null。",
    "翻译要忠实原意，不要润色、不要补充原文没有的内容。",
    '只输出 JSON：{"detected_lang": "...", "translated_zh": "..."或null, "translated_en": "..."或null}，不要输出其他文字。',
  ].join("\n");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content }],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek翻译 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function summarizeCluster(tagLabel, sampleContents, appContext) {
  const systemPrompt = buildSummaryPrompt({ tagLabel, appContext });
  const userPrompt = sampleContents.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek摘要 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function sampleDiverse(items, n) {
  return [...items].sort(() => Math.random() - 0.5).slice(0, n);
}

// Supabase/PostgREST 默认单次最多返回 1000 行，不分页会悄悄截断，必须循环拉完
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

async function runConcurrent(items, concurrency, fn) {
  const queue = [...items];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      await fn(item);
      done++;
      if (done % 100 === 0) console.log(`  进度 ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

async function processApp(app) {
  console.log(`\n=== ${app.display_name} (${app.platform}/${app.external_id}) ===`);

  if (app.platform !== "google_play") {
    console.log("暂不支持该平台的自动抓取，跳过。");
    return;
  }

  const since = app.last_fetched_at
    ? new Date(app.last_fetched_at)
    : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000);
  console.log("抓取起点:", since.toISOString());

  // 1. 多语言批次抓增量
  let fetched = [];
  for (const [lang, country] of LOCALES) {
    const batch = await withRetry(() => fetchReviewsSince(app.external_id, since, lang, country));
    fetched.push(...batch.map((r) => ({ ...r, locale: `${lang}_${country}` })));
    await new Promise((r) => setTimeout(r, 300));
  }
  const seen = new Set();
  fetched = fetched.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  console.log(`新抓到 ${fetched.length} 条`);

  if (fetched.length) {
    const rows = fetched.map((r) => ({
      id: r.id, app_id: app.id, source: "google_play", locale: r.locale,
      author: r.userName, rating: r.score, review_date: r.date, app_version: r.version,
      content: r.text, official_reply: r.replyText, official_reply_date: r.replyDate,
      ai_tags: [], ai_classified_at: null,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await supabase.from("reviews").upsert(rows.slice(i, i + 200), { onConflict: "id" });
      if (error) throw error;
    }
  }

  // 2. 分类所有未分类过的（包括这次新抓的 + 之前遗留的），分页拉全量 + 8 路并发
  // 先看看这个 App 之前已经造过哪些自定义标签（不在 baseline 里的），喂给模型优先复用，
  // 避免每次调用互不知情、造出一堆近义的碎标签。
  const classifiedSample = await fetchAllRows(
    supabase.from("reviews").select("ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const existingCustomTagsMap = new Map();
  for (const r of classifiedSample) {
    for (const t of r.ai_tags ?? []) {
      if (!BASELINE_KEYS.has(t.key)) existingCustomTagsMap.set(t.key, t.label);
    }
  }
  const existingCustomTags = [...existingCustomTagsMap.entries()].map(([key, label]) => ({ key, label }));
  console.log(`已有自定义标签 ${existingCustomTags.length} 个`);

  const unclassified = await fetchAllRows(
    supabase.from("reviews").select("id, content, rating").eq("app_id", app.id).is("ai_classified_at", null)
  );
  console.log(`待分类 ${unclassified.length} 条`);
  await runConcurrent(unclassified, 8, async (r) => {
    try {
      const tags = await withRetry(() => classifyReview(r.content, r.rating, app.context, existingCustomTags));
      const { error } = await supabase.from("reviews").update({
        ai_tags: tags, ai_tag_keys: tags.map((t) => t.key), ai_classified_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (error) throw error;
    } catch (e) {
      console.error(`分类失败 id=${r.id}:`, e.message);
    }
  });

  // 3. 翻译所有未翻译过的，同样分页拉全量 + 并发
  const untranslated = await fetchAllRows(
    supabase.from("reviews").select("id, content").eq("app_id", app.id).is("translated_at", null)
  );
  console.log(`待翻译 ${untranslated.length} 条`);
  await runConcurrent(untranslated, 8, async (r) => {
    try {
      const result = await withRetry(() => detectAndTranslate(r.content));
      const { error } = await supabase.from("reviews").update({
        detected_lang: result.detected_lang, translated_zh: result.translated_zh,
        translated_en: result.translated_en, translated_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (error) throw error;
    } catch (e) {
      console.error(`翻译失败 id=${r.id}:`, e.message);
    }
  });

  // 4. 重新生成所有标签的摘要（数据变了，摘要也要刷新）
  if (fetched.length > 0) {
    const allReviews = await fetchAllRows(
      supabase.from("reviews").select("content, ai_tags").eq("app_id", app.id)
    );
    const byTag = {};
    for (const r of allReviews) {
      for (const t of r.ai_tags ?? []) {
        (byTag[t.key] ??= { label: t.label, contents: [] }).contents.push(r.content);
      }
    }
    console.log(`刷新 ${Object.keys(byTag).length} 个标签的摘要`);
    for (const [key, { label, contents }] of Object.entries(byTag)) {
      try {
        const sample = sampleDiverse(contents, 40);
        const summary = await withRetry(() => summarizeCluster(label, sample, app.context));
        const { error } = await supabase.from("tag_summaries").upsert({
          app_id: app.id, tag_key: key, summary, sample_size: sample.length,
          generated_at: new Date().toISOString(),
        }, { onConflict: "app_id,tag_key" });
        if (error) throw error;
      } catch (e) {
        console.error(`摘要刷新失败 tag=${key}:`, e.message);
      }
    }
  } else {
    console.log("没有新数据，跳过摘要刷新");
  }

  // 5. 更新水位线
  const { error: e4 } = await supabase.from("apps").update({ last_fetched_at: new Date().toISOString() }).eq("id", app.id);
  if (e4) throw e4;
  console.log(`${app.display_name} 处理完成`);
}

async function main() {
  const { data: apps, error } = await supabase.from("apps").select("*");
  if (error) throw error;
  console.log(`共 ${apps.length} 个 App`);
  for (const app of apps) {
    await processApp(app);
  }
  console.log("\n全部完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
