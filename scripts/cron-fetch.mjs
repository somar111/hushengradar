// 定时增量任务：循环 apps 表所有 App，抓新评论 -> 真实分类 -> 翻译 -> 刷新标签摘要。
// 通用脚本，不绑定任何具体 App；加新 App 只需要在 apps 表插一行，这个脚本自动覆盖到它。
import { createClient } from "@supabase/supabase-js";
import gplayPkg from "google-play-scraper";
import { UNIVERSAL_CATEGORIES, NO_SUBTAG_KEYS, buildClassifyPrompt, buildSummaryPrompt, buildTranslatePrompt, dedupeCrossLevelTags, sanitizeTagKey } from "../lib/promptKit.mjs";

const UNIVERSAL_KEYS = new Set(UNIVERSAL_CATEGORIES.map((c) => c.key));

const gplay = gplayPkg.default ?? gplayPkg;
const SORT_NEWEST = 2;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEEPSEEK_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_LOOKBACK_DAYS = 30; // 某个 locale 还没有水位线时（新 App 或新加的 locale），往回抓多久

// 没在 apps.target_locales 配置过语言/地区列表的 App，用这份兜底（2026-06-21 探索阶段试出来的组合，
// 不代表任何特定市场分布）。每个 App 真实活跃市场不一样，新 App 接入时应该在 apps 表里配自己的
// target_locales，不要依赖这份全局默认值。
const FALLBACK_LOCALES = [
  ["en", "us"], ["id", "id"], ["es", "mx"], ["ar", "sa"], ["pt", "br"], ["hi", "in"],
  ["fr", "fr"], ["de", "de"], ["ru", "ru"], ["vi", "vn"], ["th", "th"], ["tr", "tr"],
  ["ja", "jp"], ["ko", "kr"],
];

// locale_discovery 开启时的探测候选（[lang, country]）；各 App 可在 locale_discovery.candidates 覆盖
const LOCALE_CANDIDATES = [
  ["en", "us"], ["en", "gb"], ["en", "ph"], ["en", "my"], ["en", "sg"], ["en", "in"], ["en", "au"], ["en", "ca"],
  ["id", "id"], ["th", "th"], ["vi", "vn"], ["pt", "br"], ["es", "mx"], ["es", "es"], ["fr", "fr"],
  ["de", "de"], ["ru", "ru"], ["ja", "jp"], ["ko", "kr"], ["zh", "tw"], ["zh", "hk"],
  ["ar", "sa"], ["tr", "tr"], ["hi", "in"], ["it", "it"], ["pl", "pl"], ["nl", "nl"],
  ["ms", "my"], ["tl", "ph"],
];

const DEFAULT_MIN_WEEKLY_REVIEWS = 50;
const DEFAULT_REPROBE_DAYS = 7;
const PROBE_MAX_PAGES = 5;

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

// 探测某个 locale 最近 7 天能刷到多少条评论；够阈值就提前停，不全量翻页
async function probeWeeklyReviewCount(packageName, lang, country, minReviews = DEFAULT_MIN_WEEKLY_REVIEWS) {
  const since = new Date(Date.now() - 7 * 86400000);
  let count = 0;
  let token;
  for (let page = 0; page < PROBE_MAX_PAGES; page++) {
    const res = await gplay.reviews({
      appId: packageName, sort: SORT_NEWEST, num: 150, lang, country,
      paginate: true, nextPaginationToken: token,
    });
    if (!res.data.length) break;
    for (const r of res.data) {
      if (new Date(r.date) >= since) {
        count++;
        if (count >= minReviews) return count;
      } else {
        return count;
      }
    }
    token = res.nextPaginationToken;
    if (!token) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return count;
}

async function resolveActiveLocales(app) {
  const discovery = app.locale_discovery ?? {};
  const minWeekly = discovery.minWeeklyReviews ?? DEFAULT_MIN_WEEKLY_REVIEWS;
  const reprobeDays = discovery.reprobeDays ?? DEFAULT_REPROBE_DAYS;
  const candidates = discovery.candidates?.length ? discovery.candidates : LOCALE_CANDIDATES;

  if (app.locale_probed_at) {
    const probedAt = new Date(app.locale_probed_at);
    const cutoff = new Date(Date.now() - reprobeDays * 86400000);
    if (probedAt > cutoff) {
      const cached = app.active_locales ?? [];
      console.log(`使用缓存 active_locales（${cached.length} 个），上次探测 ${app.locale_probed_at}`);
      return cached;
    }
  }

  console.log(`探测 ${candidates.length} 个候选 locale（本周 ≥${minWeekly} 条才纳入）...`);
  const active = [];
  for (const [lang, country] of candidates) {
    const localeKey = `${lang}_${country}`;
    try {
      const count = await withRetry(() => probeWeeklyReviewCount(app.external_id, lang, country, minWeekly));
      if (count >= minWeekly) {
        active.push([lang, country]);
        console.log(`  ✓ ${localeKey}: ${count} 条/周`);
      } else {
        console.log(`  · ${localeKey}: ${count} 条/周，跳过`);
      }
    } catch (e) {
      console.error(`  ✗ ${localeKey} 探测失败:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  const { error } = await supabase.from("apps").update({
    active_locales: active,
    locale_probed_at: new Date().toISOString(),
  }).eq("id", app.id);
  if (error) throw error;
  console.log(`探测完成，活跃 locale ${active.length} 个`);
  return active;
}

async function resolveFetchLocales(app) {
  if (app.target_locales?.length) {
    console.log(`手动 target_locales：${app.target_locales.length} 个`);
    return app.target_locales;
  }
  if (app.locale_discovery?.enabled) {
    return resolveActiveLocales(app);
  }
  console.log(`兜底 FALLBACK_LOCALES：${FALLBACK_LOCALES.length} 个`);
  return FALLBACK_LOCALES;
}

async function classifyReview(content, rating, appContext, seedCategories = [], existingCustomTags = [], existingSubTags = {}) {
  const systemPrompt = buildClassifyPrompt({ appContext, seedCategories, existingCustomTags, existingSubTags });

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
  let tags = parsed.tags
    .filter((t) => t && t.key && t.label)
    .map((t) => {
      const key = sanitizeTagKey(t.key);
      // 除 vague_complaint（设计上没有子问题）外，每个问题都必须有子问题，这样"子问题数字加起来
      // == 问题总数"才永远成立。模型偶尔会漏给 subKey，这里兜底塞一个"其他"，保证全覆盖、不破坏
      // 加和恒等式。通用规则，跟具体App无关。
      const noSub = NO_SUBTAG_KEYS.has(key);
      return {
        key, label: t.label, evidence: t.evidence || null,
        subKey: noSub ? null : (t.subKey ? sanitizeTagKey(t.subKey) : "general"),
        subLabel: noSub ? null : (t.subKey ? (t.subLabel || null) : "其他"),
      };
    });
  // vague_complaint 互斥兜底：它的定义就是"说不出具体问题"，所以只要同一条评论命中了任何
  // 具体类型，vague_complaint 就自相矛盾，去掉。这是"意义不明"这个类别的内在不变式，
  // 不针对任何具体App——prompt 里已经要求模型这么做，这里再兜一层防模型偶尔违背。
  if (tags.length > 1 && tags.some((t) => t.key === "vague_complaint")) {
    tags = tags.filter((t) => t.key !== "vague_complaint");
  }
  return tags;
}

async function detectAndTranslate(content) {
  const systemPrompt = buildTranslatePrompt();
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

  // 水位线按"locale"分开记，不是整个 App 共用一个：以后给这个 App 新增 locale，
  // 新 locale 在 watermarks 里没有记录，自动按 DEFAULT_LOOKBACK_DAYS 全量回溯，
  // 不会被"App 整体已经抓过"误判跳过（这是之前手动重置过一次才解决的坑，现在彻底修掉）。
  const watermarks = { ...(app.locale_watermarks ?? {}) };
  const newWatermarks = {};

  // 1. 多语言批次抓增量，每个 locale 用各自的水位线
  // 优先级：target_locales（手动）> locale_discovery（自动探测）> FALLBACK_LOCALES
  const locales = await resolveFetchLocales(app);
  let fetched = [];
  if (!locales.length) {
    console.log("无活跃 locale，跳过抓取");
  }
  for (const [lang, country] of locales) {
    const localeKey = `${lang}_${country}`;
    const since = watermarks[localeKey]
      ? new Date(watermarks[localeKey])
      : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000);
    const batch = await withRetry(() => fetchReviewsSince(app.external_id, since, lang, country));
    fetched.push(...batch.map((r) => ({ ...r, locale: localeKey })));
    newWatermarks[localeKey] = new Date().toISOString();
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

  // 1.5 抓取进度立刻落盘——不等分类/翻译跑完；进程中途挂了也不会下次全量回溯
  if (Object.keys(newWatermarks).length) {
    const { error } = await supabase.from("apps").update({
      locale_watermarks: { ...watermarks, ...newWatermarks },
    }).eq("id", app.id);
    if (error) throw error;
    console.log(`水位线已落盘（${Object.keys(newWatermarks).length} 个 locale）`);
  }

  // 2. 分类所有未分类过的（包括这次新抓的 + 之前遗留的），分页拉全量 + 8 路并发
  // 这个App的起步分类种子（加App时AI根据context提议的，不是全局共用的）+ 通用两类，
  // 凡是不在这个集合里的，都算"这个App自己造出来的custom tag"，喂给模型优先复用，
  // 避免每次调用互不知情、造出一堆近义的碎标签。
  const seedCategories = app.seed_categories ?? [];
  const baselineKeys = new Set([...UNIVERSAL_KEYS, ...seedCategories.map((c) => c.key)]);
  const classifiedSample = await fetchAllRows(
    supabase.from("reviews").select("ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const existingCustomTagsMap = new Map();
  // 按父标签分组的"已有子问题"——比如 feature_request 下已经造过哪些具体请求，跟自定义标签
  // 是同一个去重道理，只是细一级：Map<父key, Map<子key, 子label>>
  const existingSubTagsMap = new Map();
  for (const r of classifiedSample) {
    for (const t of r.ai_tags ?? []) {
      if (!baselineKeys.has(t.key)) existingCustomTagsMap.set(t.key, t.label);
      if (t.subKey) {
        const subs = existingSubTagsMap.get(t.key) ?? new Map();
        subs.set(t.subKey, t.subLabel || t.subKey);
        existingSubTagsMap.set(t.key, subs);
      }
    }
  }
  console.log(`已有自定义标签 ${existingCustomTagsMap.size} 个`);

  const unclassified = await fetchAllRows(
    supabase.from("reviews").select("id, content, rating").eq("app_id", app.id).is("ai_classified_at", null)
  );
  console.log(`待分类 ${unclassified.length} 条`);
  // existingCustomTagsMap/existingSubTagsMap 在整个分类过程中持续更新（不是开始前冻结的快照）：
  // 8个并发worker里谁先造出一个新自定义标签/子问题，其他worker接下来的调用马上就能看到、优先
  // 复用，不用各自凭感觉重新造。这点对全新App（比如第一天接入、一条已分类评论都没有）特别
  // 重要——不然第一批几千条评论会在完全看不到彼此的情况下并发跑完，容易造出一堆近义的碎标签。
  await runConcurrent(unclassified, 8, async (r) => {
    try {
      const existingCustomTags = [...existingCustomTagsMap.entries()].map(([key, label]) => ({ key, label }));
      const existingSubTags = Object.fromEntries(
        [...existingSubTagsMap.entries()].map(([parentKey, subs]) => [parentKey, [...subs.entries()].map(([key, label]) => ({ key, label }))])
      );
      const rawTags = await withRetry(() => classifyReview(r.content, r.rating, app.context, seedCategories, existingCustomTags, existingSubTags));
      // 兜底修正：如果模型还是把"已知顶层类型"塞进了别的标签当子问题（比如把performance_issue
      // 当成bug的子问题，但performance_issue本身已经是个顶层自定义标签），提升成独立顶层标签，
      // 避免同一个概念同时以两种身份重复存在
      const knownTopLevelKeys = new Set([...baselineKeys, ...existingCustomTagsMap.keys()]);
      const tags = dedupeCrossLevelTags(rawTags, knownTopLevelKeys);
      for (const t of tags) {
        if (!baselineKeys.has(t.key)) existingCustomTagsMap.set(t.key, t.label);
        if (t.subKey) {
          const subs = existingSubTagsMap.get(t.key) ?? new Map();
          subs.set(t.subKey, t.subLabel || t.subKey);
          existingSubTagsMap.set(t.key, subs);
        }
      }
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

  // 4. 重新生成所有标签的摘要——不能只看"今天有没有抓到新评论"（fetched），重新分类老评论
  // （unclassified > 0，比如批量重置 ai_classified_at 触发的全量重分类）同样会改变标签内容，
  // 必须一起触发刷新，否则摘要会带着旧的（污染过的）样本继续放着，重分类等于白做
  if (fetched.length > 0 || unclassified.length > 0) {
    const allReviews = await fetchAllRows(
      supabase.from("reviews").select("content, ai_tags").eq("app_id", app.id)
    );
    // 一条评论常常同时命中好几个标签（比如又抱怨广告、又抱怨文件丢失），用整条评论去喂每个标签的摘要
    // 会互相污染——优先用 evidence（分类时就已经摘出来的"这条评论里跟这个标签相关的部分"），
    // 没有 evidence 的老数据（还没被新版分类prompt处理过）才退回整条评论
    const byTag = {};
    for (const r of allReviews) {
      for (const t of r.ai_tags ?? []) {
        (byTag[t.key] ??= { label: t.label, contents: [] }).contents.push(t.evidence || r.content);
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

  // 5. 整条管线跑完，更新展示用时间戳（locale_watermarks 已在抓取后落盘）
  const { error: e4 } = await supabase.from("apps").update({
    last_fetched_at: new Date().toISOString(),
  }).eq("id", app.id);
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
