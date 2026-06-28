// 定时增量任务：循环 apps 表所有 App，抓新评论 -> 真实分类 -> 翻译 -> 刷新标签摘要。
// 通用脚本，不绑定任何具体 App；加新 App 只需要在 apps 表插一行，这个脚本自动覆盖到它。
import { createClient } from "@supabase/supabase-js";
import gplayPkg from "google-play-scraper";
import {
  UNIVERSAL_CATEGORIES,
  buildSubTagReusePool,
  buildTagCountsFromReviews,
  buildParentKeysWithSubs,
  findTagCountInconsistencies,
  hasTaxonomyIntents,
  subTagMapToPromptObject,
  aiTagKeysFromTags,
} from "../lib/promptKit.mjs";
import { classifyReviewWithPipeline } from "../lib/classifyReview.mjs";
import { refreshTagSummaries } from "../lib/tagSummaries.mjs";
import { ensureReplyPlaybookFresh } from "../lib/replyPlaybook.mjs";
import {
  listReviewsNeedingTranslation,
  persistTranslationResult,
  translateReviewWithPipeline,
} from "../lib/translateReview.mjs";
import { enrichFeatureRequestSubs, enrichTaxonomyIntents, getUniversalSubcategories, runGeneralBucketEnrichStage } from "../lib/taxonomyEnrich.mjs";
import { runTaxonomyStage, resetLowHitSubsForReclassify, resetReviewsForCatchAllReclassify } from "../lib/taxonomy.mjs";
import { createDeepSeekCaller } from "../lib/deepseek.mjs";

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

async function classifyPendingReviews(app, {
  seedCategories,
  universalSubcategories,
  existingCustomTagsMap,
  baselineKeys,
}) {
  const classifiedSample = await fetchAllRows(
    supabase.from("reviews").select("ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null),
  );
  const subTagReusePool = buildSubTagReusePool(seedCategories, classifiedSample, undefined, universalSubcategories);
  const pending = await fetchAllRows(
    supabase.from("reviews").select("id, content, rating").eq("app_id", app.id).is("ai_classified_at", null),
  );
  if (!pending.length) return 0;

  console.log(`待分类 ${pending.length} 条`);
  const classifyPromptBase = {
    appContext: app.context,
    seedCategories,
    universalSubcategories,
  };

  await runConcurrent(pending, 8, async (r) => {
    try {
      const existingCustomTags = [...existingCustomTagsMap.entries()].map(([key, label]) => ({ key, label }));
      const existingSubTags = subTagMapToPromptObject(subTagReusePool);
      const knownTopLevelKeys = new Set([...baselineKeys, ...existingCustomTagsMap.keys()]);
      const { tags } = await withRetry(() => classifyReviewWithPipeline(DEEPSEEK_API_KEY, {
        content: r.content,
        rating: r.rating,
        knownTopLevelKeys,
        calibrate: true,
        ...classifyPromptBase,
        existingCustomTags,
        existingSubTags,
      }));
      for (const t of tags) {
        if (!baselineKeys.has(t.key)) existingCustomTagsMap.set(t.key, t.label);
      }
      const { error } = await supabase.from("reviews").update({
        ai_tags: tags, ai_tag_keys: aiTagKeysFromTags(tags), ai_classified_at: new Date().toISOString(),
      }).eq("id", r.id);
      if (error) throw error;
    } catch (e) {
      console.error(`分类失败 id=${r.id}:`, e.message);
    }
  });
  return pending.length;
}

async function processApp(app, { skipFetch = false } = {}) {
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

  let fetched = [];
  if (skipFetch) {
    console.log("--skip-fetch：跳过 Google Play 抓取，仅跑分类/翻译/摘要。");
  } else {
  // 1. 多语言批次抓增量，每个 locale 用各自的水位线
  // 优先级：target_locales（手动）> locale_discovery（自动探测）> FALLBACK_LOCALES
  const locales = await resolveFetchLocales(app);
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
  }

  // 2. 分类所有未分类过的（包括这次新抓的 + 之前遗留的），分页拉全量 + 8 路并发
  let seedCategories = app.seed_categories ?? [];
  const callModel = createDeepSeekCaller(DEEPSEEK_API_KEY, { temperature: 0.3 });

  // P0：旧 taxonomy 缺 intent 时自动补全（一次性写回 apps.seed_categories）
  try {
    const enrichedApp = await enrichTaxonomyIntents({ supabase, app: { ...app, seed_categories: seedCategories }, callModel });
    seedCategories = enrichedApp.seed_categories ?? seedCategories;
    app = { ...app, seed_categories: seedCategories, taxonomy_meta: enrichedApp.taxonomy_meta ?? app.taxonomy_meta };
  } catch (e) {
    console.error("intent 补全失败（已跳过）：", e.message);
  }

  const universalSubcategories = getUniversalSubcategories(app);
  const baselineKeys = new Set([...UNIVERSAL_KEYS, ...seedCategories.map((c) => c.key)]);
  const classifiedSample = await fetchAllRows(
    supabase.from("reviews").select("ai_tags").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const existingCustomTagsMap = new Map();
  for (const r of classifiedSample) {
    for (const t of r.ai_tags ?? []) {
      if (!baselineKeys.has(t.key)) existingCustomTagsMap.set(t.key, t.label);
    }
  }
  const subTagReusePool = buildSubTagReusePool(seedCategories, classifiedSample, undefined, universalSubcategories);
  const subTagReuseCount = [...subTagReusePool.values()].reduce((n, m) => n + m.size, 0);
  console.log(`已有自定义标签 ${existingCustomTagsMap.size} 个，子问题复用池 ${subTagReuseCount} 个`);

  const classifiedCount = await classifyPendingReviews(app, {
    seedCategories,
    universalSubcategories,
    existingCustomTagsMap,
    baselineKeys,
  });

  // P0：有 feature_request 样本后归纳 App 级子问题（写 taxonomy_meta，供下轮分类复用）
  try {
    app = await enrichFeatureRequestSubs({ supabase, app, callModel });
  } catch (e) {
    console.error("feature_request 子问题归纳失败（已跳过）：", e.message);
  }

  const classifiedForAudit = await fetchAllRows(
    supabase.from("reviews").select("ai_tags, review_date").eq("app_id", app.id).not("ai_classified_at", "is", null)
  );
  const countIssues = findTagCountInconsistencies(
    buildTagCountsFromReviews(classifiedForAudit),
    buildParentKeysWithSubs(seedCategories, universalSubcategories, subTagMapToPromptObject(subTagReusePool)),
  );
  if (countIssues.length) {
    console.warn(
      `标签计数恒等式异常 ${countIssues.length} 个顶层（子问题之和 ≠ 母问题，多为历史数据）：`,
      countIssues.slice(0, 5).map((i) => `${i.key}(${i.parentCount}/${i.subSum})`).join("、")
    );
  }

  // 2.5 taxonomy 自治阶段：基于本轮分类后的真实标签分布，让 AI 判断体系是否合身并产出修订。
  // 非破坏性修订（改名/合并子问题/固化）自动应用并版本化；破坏性（需重读）写 pending_reclassify
  // 等人工确认。失败不影响抓取/翻译主流程——分类体系维护是增量优化，不是关键路径。
  let taxonomyChanged = false;
  try {
    const report = await runTaxonomyStage({
      supabase,
      app,
      callModel,
      options: { classifiedReviews: classifiedForAudit },
    });
    taxonomyChanged = report.action !== "none" && !report.dryRun;
  } catch (e) {
    console.error("taxonomy 阶段失败（已跳过，不影响主流程）：", e.message);
  }

  // 2.6 低命中 ephemeral sub 重置并重分类（taxonomy 设计清单外的 sub，命中 ≤4 条）
  let lowSubsReclassified = 0;
  try {
    const { data: freshApp, error: freshErr } = await supabase.from("apps").select("*").eq("id", app.id).single();
    if (freshErr) throw freshErr;
    if (freshApp) {
      app = freshApp;
      seedCategories = app.seed_categories ?? seedCategories;
    }
    const uniAfterTaxonomy = getUniversalSubcategories(app);
    const lowSubsReset = await resetLowHitSubsForReclassify({
      supabase,
      app,
      seedCategories,
      universalSubcategories: uniAfterTaxonomy,
      logger: console,
    });
    if (lowSubsReset > 0) {
      lowSubsReclassified = await classifyPendingReviews(app, {
        seedCategories,
        universalSubcategories: uniAfterTaxonomy,
        existingCustomTagsMap,
        baselineKeys,
      });
    }
  } catch (e) {
    console.error("低命中子问题重分类失败（已跳过）：", e.message);
  }

  // 2.7 「其他」桶信号：general 够多 → enrich 新 sub → 重读「其他」下评论
  let generalReclassified = 0;
  try {
    const { data: auditRows, error: auditErr } = await supabase
      .from("reviews")
      .select("content, ai_tags")
      .eq("app_id", app.id)
      .not("ai_classified_at", "is", null);
    if (auditErr) throw auditErr;

    const { app: enrichedApp, results: generalEnrichResults } = await runGeneralBucketEnrichStage({
      supabase,
      app,
      callModel,
      reviews: auditRows ?? [],
      logger: console,
    });
    app = enrichedApp;
    seedCategories = app.seed_categories ?? seedCategories;
    for (const { parentKey, addedSubs } of generalEnrichResults) {
      if (!addedSubs.length) continue;
      const uniAfterGeneral = getUniversalSubcategories(app);
      const reset = await resetReviewsForCatchAllReclassify({ supabase, app, parentKey });
      if (reset > 0) {
        console.log(`[general-enrich] 重置 ${parentKey}「其他」${reset} 条，重分类中…`);
        generalReclassified += await classifyPendingReviews(app, {
          seedCategories,
          universalSubcategories: uniAfterGeneral,
          existingCustomTagsMap,
          baselineKeys,
        });
      }
    }
  } catch (e) {
    console.error("general 桶 enrich/重分类失败（已跳过）：", e.message);
  }

  // 3. 翻译：从未翻译 + 已标记但缺必需译文的（假完成）一并处理
  const needsTranslation = await listReviewsNeedingTranslation(supabase, app.id);
  console.log(`待翻译 ${needsTranslation.length} 条`);
  let translatedOk = 0;
  let translatedIncomplete = 0;
  await runConcurrent(needsTranslation, 8, async (r) => {
    try {
      const result = await withRetry(() =>
        translateReviewWithPipeline(DEEPSEEK_API_KEY, r.content, {
          appContext: app.context,
          displayName: app.display_name,
          terminologyGlossary: app.terminology_glossary ?? [],
        })
      );
      const saved = await persistTranslationResult(supabase, r.id, result);
      if (saved.ok) translatedOk++;
      else {
        translatedIncomplete++;
        console.warn(`翻译不完整 id=${r.id} lang=${result.detected_lang ?? "?"}`);
      }
    } catch (e) {
      console.error(`翻译失败 id=${r.id}:`, e.message);
    }
  });
  if (translatedIncomplete) console.log(`翻译跳过（模型仍缺必需字段）${translatedIncomplete} 条，下轮 cron 重试`);
  if (translatedOk) console.log(`翻译完成 ${translatedOk} 条`);

  // 4. 重新生成所有标签的摘要——不能只看"今天有没有抓到新评论"（fetched），重新分类老评论
  // （unclassified > 0，比如批量重置 ai_classified_at 触发的全量重分类）同样会改变标签内容，
  // 必须一起触发刷新，否则摘要会带着旧的（污染过的）样本继续放着，重分类等于白做
  if (fetched.length > 0 || classifiedCount > 0 || taxonomyChanged || lowSubsReclassified > 0 || generalReclassified > 0) {
    const { refreshed } = await refreshTagSummaries({
      supabase,
      appId: app.id,
      apiKey: DEEPSEEK_API_KEY,
      appContext: app.context,
      logger: console,
    });
    console.log(`刷新 ${refreshed} 个标签的摘要`);
  } else {
    console.log("没有新数据、也无 taxonomy 变更，跳过摘要刷新");
  }

  const { refreshed: playbookRefreshed } = await ensureReplyPlaybookFresh({
    supabase,
    app,
    apiKey: DEEPSEEK_API_KEY,
    logger: console,
  });
  if (playbookRefreshed) console.log("已刷新回复建议 playbook");

  // 5. 整条管线跑完，更新展示用时间戳（locale_watermarks 已在抓取后落盘）
  const { error: e4 } = await supabase.from("apps").update({
    last_fetched_at: new Date().toISOString(),
  }).eq("id", app.id);
  if (e4) throw e4;
  console.log(`${app.display_name} 处理完成`);
}

async function main() {
  const argv = process.argv.slice(2);
  const skipFetch = argv.includes("--skip-fetch");
  const appArg = argv.find((a) => !a.startsWith("--"));
  const { data: apps, error } = await supabase.from("apps").select("*");
  if (error) throw error;
  let targets = apps;
  if (appArg) {
    targets = apps.filter(
      (a) => a.id === appArg || a.external_id === appArg
        || a.display_name?.toLowerCase().includes(appArg.toLowerCase())
    );
    if (!targets.length) throw new Error(`找不到 App：${appArg}`);
    console.log(`仅处理 ${targets.length} 个 App（筛选：${appArg}）`);
  } else {
    console.log(`共 ${apps.length} 个 App`);
  }
  for (const app of targets) {
    await processApp(app, { skipFetch });
  }
  console.log("\n全部完成。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
