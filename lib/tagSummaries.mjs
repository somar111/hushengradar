// 标签聚类摘要：cron、Demo stats、Ask 共用 summarizeCluster；evidence 是输入样本，不是 UI 文案。

import { buildSummaryPrompt, buildScopedReviewSummaryPrompt, hasSubTagBreakdown } from "./promptKit.mjs";

export function sampleDiverse(items, n) {
  return [...items].sort(() => Math.random() - 0.5).slice(0, n);
}

export async function summarizeCluster(apiKey, tagLabel, sampleContents, appContext) {
  const systemPrompt = buildSummaryPrompt({ tagLabel, appContext });
  const userPrompt = sampleContents.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
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

const SCOPED_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { summary: string, fetchedAt: number }>} */
const scopedSummaryCache = new Map();

export function scopedSummaryCacheKey(appId, locale, since, until, tagKey) {
  return `${appId}|${locale ?? ""}|${since ?? ""}|${until ?? ""}|${tagKey}`;
}

export function invalidateScopedSummaryCache(appId) {
  if (!appId) {
    scopedSummaryCache.clear();
    return;
  }
  for (const key of scopedSummaryCache.keys()) {
    if (key.startsWith(`${appId}|`)) scopedSummaryCache.delete(key);
  }
}

const SCOPED_REVIEW_SUMMARY_CACHE_TTL_MS = 15 * 60 * 1000;
/** @type {Map<string, { payload: object, fetchedAt: number }>} */
const scopedReviewSummaryCache = new Map();

export function scopedReviewSummaryCacheKey(appId, locale, since, until, tag, subTag, q, rating) {
  return `reviewScope|${appId}|${locale ?? ""}|${since ?? ""}|${until ?? ""}|${tag ?? ""}|${subTag ?? ""}|${q ?? ""}|${rating ?? ""}`;
}

export function invalidateScopedReviewSummaryCache(appId) {
  if (!appId) {
    scopedReviewSummaryCache.clear();
    return;
  }
  const prefix = `reviewScope|${appId}|`;
  for (const key of scopedReviewSummaryCache.keys()) {
    if (key.startsWith(prefix)) scopedReviewSummaryCache.delete(key);
  }
}

const EVIDENCE_BATCH_SIZE = 40;

function parseThemesJson(raw) {
  const text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : text;
  try {
    const parsed = JSON.parse(candidate);
    const themes = Array.isArray(parsed?.themes) ? parsed.themes : [];
    return themes
      .map((t) => ({
        label: String(t?.label ?? "").trim(),
        description: String(t?.description ?? "").trim(),
      }))
      .filter((t) => t.label && t.description);
  } catch {
    if (!text) return [];
    return [{ label: "归纳", description: text.slice(0, 500) }];
  }
}

async function callDeepSeekThemes(apiKey, systemPrompt, userPrompt) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek主题归纳 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return parseThemesJson(data.choices?.[0]?.message?.content);
}

async function summarizeEvidenceBatch(apiKey, scopeLabel, evidences, appContext) {
  const systemPrompt = buildScopedReviewSummaryPrompt({ scopeLabel, appContext, phase: "summarize" });
  const userPrompt = evidences.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return callDeepSeekThemes(apiKey, systemPrompt, userPrompt);
}

/**
 * 对 scope 内全部 evidence 做 map-reduce 主题归纳（Ask summarize_reviews 用）。
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.scopeLabel
 * @param {string[]} opts.evidences
 * @param {string} [opts.appContext]
 * @returns {Promise<{ themes: { label: string, description: string }[], llmCalls: number }>}
 */
export async function mapReduceSummarizeEvidence({ apiKey, scopeLabel, evidences, appContext }) {
  if (!evidences.length) return { themes: [], llmCalls: 0 };

  if (evidences.length <= EVIDENCE_BATCH_SIZE) {
    const themes = await summarizeEvidenceBatch(apiKey, scopeLabel, evidences, appContext);
    return { themes, llmCalls: 1 };
  }

  const batches = [];
  for (let i = 0; i < evidences.length; i += EVIDENCE_BATCH_SIZE) {
    batches.push(evidences.slice(i, i + EVIDENCE_BATCH_SIZE));
  }

  const partials = await Promise.all(
    batches.map((batch, i) =>
      summarizeEvidenceBatch(apiKey, `${scopeLabel}（第 ${i + 1}/${batches.length} 批）`, batch, appContext),
    ),
  );

  const mergePrompt = buildScopedReviewSummaryPrompt({ scopeLabel, appContext, phase: "merge" });
  const userPrompt = partials
    .map((themes, i) => `## 第 ${i + 1} 批\n${JSON.stringify({ themes }, null, 0)}`)
    .join("\n\n");
  const themes = await callDeepSeekThemes(apiKey, mergePrompt, userPrompt);
  return { themes, llmCalls: batches.length + 1 };
}

/**
 * @param {string} appId
 * @param {string} [locale]
 * @param {string} [since]
 * @param {string} [until]
 * @param {string} [tag]
 * @param {string} [opts.subTag]
 * @param {string} [q]
 * @param {number} [rating]
 */
export function getCachedScopedReviewSummary(appId, locale, since, until, tag, subTag, q, rating) {
  const key = scopedReviewSummaryCacheKey(appId, locale, since, until, tag, subTag, q, rating);
  const cached = scopedReviewSummaryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SCOPED_REVIEW_SUMMARY_CACHE_TTL_MS) {
    return { key, payload: cached.payload, fromCache: true };
  }
  return { key, payload: null, fromCache: false };
}

export function setCachedScopedReviewSummary(cacheKey, payload) {
  scopedReviewSummaryCache.set(cacheKey, { payload, fetchedAt: Date.now() });
}

/** 与 refreshTagSummaries 一致：优先 evidence，无则退回评论原文作样本。 */
export function pushTagSample(samplesByKey, tag, reviewContent) {
  if (!tag?.key) return;
  const text = String(tag.evidence ?? "").trim() || String(reviewContent ?? "").trim();
  if (!text) return;
  const list = samplesByKey[tag.key] ?? [];
  list.push(text);
  samplesByKey[tag.key] = list;
}

/**
 * 当前 stats 筛选下的展示摘要（与 tag_summaries 同管线，样本池为 scope 内评论）。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.apiKey
 * @param {string} [opts.appContext]
 * @param {string} [opts.locale]
 * @param {string} [opts.since]
 * @param {string} [opts.until]
 * @param {{ key: string, label: string, contents: string[], subTags: Record<string, { label: string, count: number }> }[]} opts.tags
 * @param {(msg: string) => void} [opts.logger]
 * @returns {Promise<Record<string, string|null>>}
 */
export async function summarizeTagsForScope({
  appId,
  apiKey,
  appContext,
  locale,
  since,
  until,
  tags,
  logger = console,
}) {
  /** @type {Record<string, string|null>} */
  const out = {};
  await Promise.all(
    tags.map(async ({ key, label, contents, subTags }) => {
      if (hasSubTagBreakdown(subTags)) {
        out[key] = null;
        return;
      }
      if (!contents.length) {
        out[key] = null;
        return;
      }

      const cacheKey = scopedSummaryCacheKey(appId, locale, since, until, key);
      const cached = scopedSummaryCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < SCOPED_SUMMARY_CACHE_TTL_MS) {
        out[key] = cached.summary;
        return;
      }

      try {
        const sample = sampleDiverse(contents, 40);
        const summary = await summarizeCluster(apiKey, label, sample, appContext);
        scopedSummaryCache.set(cacheKey, { summary, fetchedAt: Date.now() });
        out[key] = summary;
      } catch (e) {
        logger.warn?.(`[tagSummaries] scoped 摘要失败 tag=${key}: ${e.message}`)
          ?? logger.log(`[tagSummaries] scoped 摘要失败 tag=${key}: ${e.message}`);
        out[key] = null;
      }
    }),
  );
  return out;
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

/**
 * 按当前全库 ai_tags 重算 tag_summaries（维度：app + tag_key，无 locale/时间）。
 * 仅供无筛选 stats 视图的 Top 反馈兜底摘要；带 locale 或 since/until 时由 summarizeTagsForScope 按同管线生成。
 * @param {object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.supabase
 * @param {string} opts.appId
 * @param {string} opts.apiKey
 * @param {string} [opts.appContext]
 * @param {Set<string>|string[]|null} [opts.tagKeys] 仅刷新这些顶层 key；缺省则刷新所有有命中的 tag
 * @param {(msg: string) => void} [opts.logger]
 * @returns {Promise<{ refreshed: number, cleared: number }>}
 */
export async function refreshTagSummaries({
  supabase,
  appId,
  apiKey,
  appContext,
  tagKeys = null,
  logger = console,
}) {
  const keyFilter = tagKeys == null ? null : new Set(tagKeys);

  const allReviews = await fetchAllRows(
    supabase.from("reviews").select("content, ai_tags").eq("app_id", appId).not("ai_classified_at", "is", null),
  );

  /** @type {Record<string, { label: string, contents: string[] }>} */
  const byTag = {};
  for (const r of allReviews) {
    for (const t of r.ai_tags ?? []) {
      if (!t?.key) continue;
      if (keyFilter && !keyFilter.has(t.key)) continue;
      const entry = byTag[t.key] ?? { label: t.label, contents: [] };
      const text = String(t.evidence ?? "").trim() || String(r.content ?? "").trim();
      if (text) entry.contents.push(text);
      byTag[t.key] = entry;
    }
  }

  let refreshed = 0;
  for (const [key, { label, contents }] of Object.entries(byTag)) {
    try {
      const sample = sampleDiverse(contents, 40);
      const summary = await summarizeCluster(apiKey, label, sample, appContext);
      const { error } = await supabase.from("tag_summaries").upsert(
        {
          app_id: appId,
          tag_key: key,
          summary,
          sample_size: sample.length,
          generated_at: new Date().toISOString(),
        },
        { onConflict: "app_id,tag_key" },
      );
      if (error) throw error;
      refreshed++;
    } catch (e) {
      logger.warn?.(`[tagSummaries] 刷新失败 tag=${key}: ${e.message}`) ?? logger.log(`[tagSummaries] 刷新失败 tag=${key}: ${e.message}`);
    }
  }

  let cleared = 0;
  if (keyFilter) {
    for (const key of keyFilter) {
      if (byTag[key]) continue;
      const { error } = await supabase.from("tag_summaries").delete().eq("app_id", appId).eq("tag_key", key);
      if (error) throw error;
      cleared++;
    }
  }

  return { refreshed, cleared };
}
