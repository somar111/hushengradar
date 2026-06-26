// 单条评论分类管线：分类 → 结构校验 → 语义校准（P1）。
// cron-fetch 与测试共用，避免脚本里重复维护 DeepSeek 调用逻辑。

import {
  CLASSIFY_RETRY_ATTEMPTS,
  buildCalibratePrompt,
  buildClassifyPrompt,
  buildParentKeysWithSubs,
  fallbackTagsForRating,
  finalizeClassifiedTags,
  needsSemanticCalibration,
  parseCalibrateTagsFromModel,
  parseClassifyTagsFromModel,
  validateClassifiedTags,
} from "./promptKit.mjs";

async function chatJson(apiKey, systemPrompt, userPrompt, { temperature = 0.2 } = {}) {
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

export async function classifyReviewRaw(apiKey, content, rating, opts) {
  const systemPrompt = buildClassifyPrompt(opts);
  const parsed = await chatJson(
    apiKey,
    systemPrompt,
    `评分：${rating} 星\n评论内容：${content}`,
    { temperature: 0.2 },
  );
  return parseClassifyTagsFromModel(parsed.tags);
}

export async function calibrateReviewTags(apiKey, content, rating, tags, opts) {
  const systemPrompt = buildCalibratePrompt(opts);
  const tagJson = JSON.stringify(tags, null, 0);
  const parsed = await chatJson(
    apiKey,
    systemPrompt,
    `评分：${rating} 星\n评论内容：${content}\n\n当前分类：${tagJson}`,
    { temperature: 0.1 },
  );
  if (parsed?.verdict !== "reroute" || !Array.isArray(parsed.tags)) {
    return { tags, calibrated: false, reason: parsed?.reason ?? null };
  }
  return {
    tags: parseCalibrateTagsFromModel(parsed.tags),
    calibrated: true,
    reason: parsed?.reason ?? null,
  };
}

function passesValidation(tags, knownTopLevelKeys, parentKeysWithSubs) {
  return validateClassifiedTags(tags, knownTopLevelKeys, parentKeysWithSubs).ok;
}

/**
 * 完整分类：结构校验 + 可选语义校准。
 * @param {string} apiKey
 * @param {{ content: string, rating: number, knownTopLevelKeys: Set<string>, calibrate?: boolean } & Parameters<typeof buildClassifyPrompt>[0]} opts
 */
export async function classifyReviewWithPipeline(apiKey, { content, rating, knownTopLevelKeys, calibrate = true, ...promptOpts }) {
  const parentKeysWithSubs = buildParentKeysWithSubs(
    promptOpts.seedCategories,
    promptOpts.universalSubcategories,
    promptOpts.existingSubTags,
  );
  const finalizeOpts = { knownTopLevelKeys, rating, parentKeysWithSubs };
  const calibrateCtx = { ...promptOpts, parentKeysWithSubs };
  const attempts = 1 + CLASSIFY_RETRY_ATTEMPTS;
  let lastRaw = [];
  let tags = [];

  for (let i = 0; i < attempts; i++) {
    lastRaw = await classifyReviewRaw(apiKey, content, rating, promptOpts);
    const candidate = finalizeClassifiedTags(lastRaw, finalizeOpts);
    if (passesValidation(candidate, knownTopLevelKeys, parentKeysWithSubs)) {
      tags = candidate;
      break;
    }
  }
  if (!tags.length) {
    tags = finalizeClassifiedTags(lastRaw, finalizeOpts);
  }

  let validationOk = passesValidation(tags, knownTopLevelKeys, parentKeysWithSubs);
  const shouldCalibrate = calibrate && (!validationOk || needsSemanticCalibration(tags, calibrateCtx));

  if (shouldCalibrate) {
    const result = await calibrateReviewTags(apiKey, content, rating, tags, promptOpts);
    const finalized = finalizeClassifiedTags(result.tags, finalizeOpts);
    if (passesValidation(finalized, knownTopLevelKeys, parentKeysWithSubs)) {
      return {
        tags: finalized,
        calibrated: result.calibrated || !validationOk,
        reason: result.reason ?? (!validationOk ? "结构校验失败后校准通过" : null),
      };
    }
    if (validationOk) {
      return { tags, calibrated: false, reason: "校准结果未通过结构校验，保留原分类" };
    }
    tags = finalized.length ? finalized : tags;
    validationOk = passesValidation(tags, knownTopLevelKeys, parentKeysWithSubs);
    return {
      tags,
      calibrated: result.calibrated,
      reason: result.reason ?? (validationOk ? null : "结构校验未通过，保留校准/分类最佳结果"),
    };
  }

  if (!tags.length) tags = fallbackTagsForRating(rating);
  return {
    tags,
    calibrated: false,
    ...(validationOk ? {} : { reason: "结构校验未通过" }),
  };
}
