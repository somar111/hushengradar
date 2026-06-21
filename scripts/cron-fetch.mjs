// 定时增量任务：循环 apps 表所有 App，抓新评论 -> 真实分类 -> 翻译 -> 刷新标签摘要。
// 通用脚本，不绑定任何具体 App；加新 App 只需要在 apps 表插一行，这个脚本自动覆盖到它。
import { createClient } from "@supabase/supabase-js";
import gplayPkg from "google-play-scraper";

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

async function classifyReview(content, rating, appContext) {
  const baselineList = "billing(扣费/订阅投诉)、bug(功能故障)、ads(广告骚扰)、ui_regression(改版体验倒退)、paywall(付费墙限制)、login_sync(登录/同步问题)、feature_request(功能请求)、praise(正面评价)";
  const systemPrompt = [
    "你是应用商店评论分析助手，给一条用户评论打问题类型标签。",
    `常见类型供参考：${baselineList}。`,
    "如果评论内容不属于以上任何一种，可以自己创建一个新的 key（英文 snake_case）和对应的中文 label，不要硬塞进不合适的类型。",
    "一条评论可以命中多个类型，也可以是空数组（比如内容完全中立、看不出明确诉求）。",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "..."}]}，不要输出任何其他文字。',
  ].filter(Boolean).join("\n");

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
  return Array.isArray(parsed.tags) ? parsed.tags : [];
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
  const systemPrompt = [
    `下面是一批被归类为"${tagLabel}"的应用商店评论样本。`,
    "请用一句简短中文短语概括这些评论具体在说什么，要紧贴样本内容，不要泛泛而谈，不要编造样本里没有的细节。",
    "输出的短语要能直接接在「N 条评论」后面组成完整句子——不要重复「评论」「条」这些字，不要加引号或多余前后缀，不要输出数字统计。",
    `这款 App 的背景信息：${appContext}`,
  ].join("\n");
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

  // 2. 分类所有未分类过的（包括这次新抓的 + 之前遗留的）
  const { data: unclassified, error: e1 } = await supabase
    .from("reviews").select("id, content, rating").eq("app_id", app.id).is("ai_classified_at", null);
  if (e1) throw e1;
  console.log(`待分类 ${unclassified.length} 条`);
  for (const r of unclassified) {
    try {
      const tags = await withRetry(() => classifyReview(r.content, r.rating, app.context));
      const { error } = await supabase.from("reviews").update({
        ai_tags: tags, ai_tag_keys: tags.map((t) => t.key), ai_classified_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (error) throw error;
    } catch (e) {
      console.error(`分类失败 id=${r.id}:`, e.message);
    }
  }

  // 3. 翻译所有未翻译过的
  const { data: untranslated, error: e2 } = await supabase
    .from("reviews").select("id, content").eq("app_id", app.id).is("translated_at", null);
  if (e2) throw e2;
  console.log(`待翻译 ${untranslated.length} 条`);
  for (const r of untranslated) {
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
  }

  // 4. 重新生成所有标签的摘要（数据变了，摘要也要刷新）
  if (fetched.length > 0) {
    const { data: allReviews, error: e3 } = await supabase
      .from("reviews").select("content, ai_tags").eq("app_id", app.id);
    if (e3) throw e3;
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
