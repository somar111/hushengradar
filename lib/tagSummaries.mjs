// 标签聚类摘要：cron、Demo stats、Ask 共用 summarizeCluster；evidence 是输入样本，不是 UI 文案。

import { buildSummaryPrompt, hasSubTagBreakdown } from "./promptKit.mjs";

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
