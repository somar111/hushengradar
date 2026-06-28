// 单条评论翻译管线：调用模型 → 结构校验 → 不合格重试 → 缺字段补译。cron / API / 补译脚本共用。

import {
  TRANSLATE_RETRY_ATTEMPTS,
  buildTranslatePrompt,
  formatTerminologyGlossaryBlock,
  isTranslateResultComplete,
  normalizeTranslateResult,
  reviewNeedsTranslation,
} from "./promptKit.mjs";
import { DEEPSEEK_URL, fetchDeepSeekWithRetry } from "./deepseekFetch.mjs";

export { isTranslateResultComplete, normalizeTranslateResult, reviewNeedsTranslation };

async function chatJson(apiKey, systemPrompt, userPrompt, { temperature = 0.1 } = {}) {
  const res = await fetchDeepSeekWithRetry(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature,
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

function buildTranslateFallbackPrompt(partial, promptOpts = {}) {
  const lang = partial.detected_lang || "?";
  const needZh = lang !== "zh" && !partial.translated_zh;
  const needEn = lang !== "en" && !partial.translated_en;
  return [
    "你是翻译助手。上一步翻译 JSON 缺必需字段，请只补缺失部分。",
    `detected_lang 保持为「${lang}」，不要改。`,
    needZh ? "必须补全 translated_zh（简体中文），不得为 null。" : "translated_zh 保持上一步结果（可为 null）。",
    needEn ? "必须补全 translated_en（英文），不得为 null。" : "translated_en 保持上一步结果（可为 null）。",
    formatTerminologyGlossaryBlock(promptOpts.terminologyGlossary, { displayName: promptOpts.displayName }),
    promptOpts.appContext ? `App 背景：${promptOpts.appContext}` : "",
    '只输出 JSON：{"detected_lang":"...","translated_zh":"..."或null,"translated_en":"..."或null}',
  ].filter(Boolean).join("\n");
}

async function patchMissingTranslationFields(apiKey, content, partial, promptOpts) {
  const lang = partial.detected_lang;
  if (!lang) return partial;
  const needZh = lang !== "zh" && !partial.translated_zh;
  const needEn = lang !== "en" && !partial.translated_en;
  if (!needZh && !needEn) return partial;

  const userPrompt = [
    `原文：${content}`,
    `上一步结果：${JSON.stringify(partial)}`,
  ].join("\n\n");

  const parsed = await chatJson(apiKey, buildTranslateFallbackPrompt(partial, promptOpts), userPrompt, {
    temperature: 0.05,
  });
  return normalizeTranslateResult({ ...partial, ...parsed, detected_lang: partial.detected_lang });
}

/**
 * @param {string} apiKey
 * @param {string} content
 * @param {Parameters<typeof buildTranslatePrompt>[0]} promptOpts
 */
export async function translateReviewWithPipeline(apiKey, content, promptOpts = {}) {
  const systemPrompt = buildTranslatePrompt(promptOpts);
  const attempts = 1 + TRANSLATE_RETRY_ATTEMPTS;
  let last = normalizeTranslateResult({});

  for (let i = 0; i < attempts; i++) {
    const parsed = await chatJson(apiKey, systemPrompt, content);
    last = normalizeTranslateResult(parsed);
    if (isTranslateResultComplete(last)) return last;
  }

  last = await patchMissingTranslationFields(apiKey, content, last, promptOpts);
  if (isTranslateResultComplete(last)) return last;

  return last;
}

/** 分页拉全量（Supabase 默认 1000 行上限） */
export async function fetchAllRows(query, pageSize = 1000) {
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
 * 列出某 App 下需要（含重）翻译的评论：从未翻译，或已有 translated_at 但缺必需译文。
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 */
export async function listReviewsNeedingTranslation(supabase, appId) {
  const rows = await fetchAllRows(
    supabase
      .from("reviews")
      .select("id, content, detected_lang, translated_zh, translated_en, translated_at")
      .eq("app_id", appId)
      .not("content", "is", null),
  );
  return rows.filter((r) => reviewNeedsTranslation(r));
}

/**
 * 校验通过后写库；不完整则不写 translated_at（避免「假完成」）。
 * @returns {{ ok: boolean, incomplete?: boolean }}
 */
export async function persistTranslationResult(supabase, reviewId, result) {
  const normalized = normalizeTranslateResult(result);
  if (!isTranslateResultComplete(normalized)) {
    return { ok: false, incomplete: true };
  }
  const { error } = await supabase
    .from("reviews")
    .update({
      detected_lang: normalized.detected_lang,
      translated_zh: normalized.translated_zh,
      translated_en: normalized.translated_en,
      translated_at: new Date().toISOString(),
    })
    .eq("id", reviewId);
  if (error) throw error;
  return { ok: true };
}
