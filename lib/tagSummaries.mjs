// 标签聚类摘要：cron 与 Demo「重跑分类」共用，避免重分类后 Top 反馈仍显示旧摘要。

import { buildSummaryPrompt } from "./promptKit.mjs";

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
 * 按当前全库 ai_tags 重算 tag_summaries。
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
      entry.contents.push(t.evidence || r.content);
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
