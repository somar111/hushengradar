// 回复建议：离线 playbook 压缩 + 在线输入指纹。模式对齐 tag_summaries——先消化静态配置，在线只带本条评论。

import { createHash } from "node:crypto";
import { detectReplyContactTrigger, formatTerminologyGlossaryBlock } from "./promptKit.mjs";
import { DEEPSEEK_URL, fetchDeepSeekWithRetry } from "./deepseekFetch.mjs";
import {
  DEFAULT_REPLY_SETTINGS,
  mergeReplySettings,
  normalizeReplySettings,
} from "./replySettings.shared.mjs";

export { DEFAULT_REPLY_SETTINGS, mergeReplySettings, normalizeReplySettings };

export function computeReplyPlaybookInputsHash({
  context,
  replySettings,
  terminologyGlossary,
  displayName,
}) {
  const normalized = normalizeReplySettings(replySettings);
  const glossary = Array.isArray(terminologyGlossary)
    ? terminologyGlossary.map((e) => ({
        source: String(e?.source ?? "").trim(),
        zh: e?.zh ?? null,
        en: e?.en ?? null,
        note: e?.note ?? null,
      }))
    : [];
  const payload = JSON.stringify({
    context: String(context ?? "").trim(),
    replySettings: normalized,
    glossary,
    displayName: String(displayName ?? "").trim(),
    v: 1,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** 无 LLM 时的确定性短手册（在线兜底，cron 失败时仍可用）。 */
export function buildDeterministicPlaybookFallback({
  displayName,
  context,
  replySettings,
  terminologyGlossary,
}) {
  const s = normalizeReplySettings(replySettings);
  const glossary = formatTerminologyGlossaryBlock(terminologyGlossary, { displayName });
  return [
    displayName ? `App：${displayName}` : "",
    context ? `产品背景：${String(context).trim().slice(0, 450)}` : "",
    `语气：${s.tone.slice(0, 280)}`,
    `句式：${s.style.slice(0, 120)}`,
    s.contactInfo ? `联系方式（按条件使用，禁止编造其他邮箱）：${s.contactInfo.slice(0, 320)}` : "未配置联系方式，禁止出现邮箱/网址/电话。",
    glossary,
    "用评论原文语言回复；整条只用一种语言。",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1600);
}

function buildReplyPlaybookCompressPrompt() {
  return [
    "你是知识压缩助手。把输入的 App 回复策略压成一份「回复 playbook」，供后续每条评论生成时复用。",
    "要求：中文、250 字以内；保留产品是什么、语气、句式长度、联系方式使用条件；邮箱须与输入逐字一致；术语表只保留关键专名；删除重复表述。",
    "只输出 playbook 正文，不要 JSON、不要标题编号。",
  ].join("\n");
}

function buildReplyPlaybookSource({ displayName, context, replySettings, terminologyGlossary }) {
  const s = normalizeReplySettings(replySettings);
  const glossary = formatTerminologyGlossaryBlock(terminologyGlossary, { displayName });
  return [
    displayName ? `App 名称：${displayName}` : "",
    context ? `产品背景：${context}` : "",
    `语气要求：${s.tone}`,
    `句式要求：${s.style}`,
    s.contactInfo ? `联系方式规则：${s.contactInfo}` : "未配置联系方式。",
    glossary,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function compressReplyPlaybookWithLlm(apiKey, source) {
  const res = await fetchDeepSeekWithRetry(DEEPSEEK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: buildReplyPlaybookCompressPrompt() },
        { role: "user", content: source },
      ],
      temperature: 0.2,
    }),
  });
  const data = await res.json();
  const text = String(data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("playbook 压缩结果为空");
  return text.slice(0, 900);
}

/**
 * @param {object} opts
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.supabase
 * @param {object} opts.app
 * @param {string} opts.apiKey
 * @param {boolean} [opts.force]
 */
export async function refreshReplyPlaybook({ supabase, app, apiKey, force = false }) {
  const replySettings = normalizeReplySettings(app.reply_settings);
  const hash = computeReplyPlaybookInputsHash({
    context: app.context,
    replySettings,
    terminologyGlossary: app.terminology_glossary,
    displayName: app.display_name,
  });

  if (!force && app.reply_playbook && app.reply_playbook_inputs_hash === hash) {
    return { playbook: app.reply_playbook, hash, refreshed: false };
  }

  const source = buildReplyPlaybookSource({
    displayName: app.display_name,
    context: app.context,
    replySettings,
    terminologyGlossary: app.terminology_glossary,
  });

  let playbook;
  try {
    playbook = await compressReplyPlaybookWithLlm(apiKey, source);
  } catch {
    playbook = buildDeterministicPlaybookFallback({
      displayName: app.display_name,
      context: app.context,
      replySettings,
      terminologyGlossary: app.terminology_glossary,
    });
  }

  const at = new Date().toISOString();
  const { error } = await supabase
    .from("apps")
    .update({
      reply_playbook: playbook,
      reply_playbook_at: at,
      reply_playbook_inputs_hash: hash,
      reply_settings: replySettings,
    })
    .eq("id", app.id);
  if (error) throw error;

  return { playbook, hash, refreshed: true };
}

/** cron / API：仅在输入变更或缺失时刷新。 */
export async function ensureReplyPlaybookFresh({ supabase, app, apiKey, logger = console }) {
  const hash = computeReplyPlaybookInputsHash({
    context: app.context,
    replySettings: app.reply_settings,
    terminologyGlossary: app.terminology_glossary,
    displayName: app.display_name,
  });
  if (app.reply_playbook && app.reply_playbook_inputs_hash === hash) {
    return { refreshed: false, playbook: app.reply_playbook };
  }
  try {
    const result = await refreshReplyPlaybook({ supabase, app, apiKey, force: true });
    logger.log?.(`[replyPlaybook] 已刷新 app=${app.display_name}`) ?? logger.log(`[replyPlaybook] 已刷新 app=${app.display_name}`);
    return { refreshed: result.refreshed, playbook: result.playbook };
  } catch (e) {
    logger.warn?.(`[replyPlaybook] 刷新失败: ${e.message}`) ?? logger.log(`[replyPlaybook] 刷新失败: ${e.message}`);
    return {
      refreshed: false,
      playbook:
        app.reply_playbook ??
        buildDeterministicPlaybookFallback({
          displayName: app.display_name,
          context: app.context,
          replySettings: app.reply_settings,
          terminologyGlossary: app.terminology_glossary,
        }),
    };
  }
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function pickContactEmail(contactInfo, trigger) {
  const emails = [...String(contactInfo ?? "").matchAll(EMAIL_RE)].map((m) => m[0]);
  if (!emails.length) return null;
  if (trigger === "refund") {
    return emails.find((e) => /refund/i.test(e)) ?? emails[0];
  }
  return emails.find((e) => /support/i.test(e)) ?? emails.find((e) => !/refund/i.test(e)) ?? emails[0];
}

/** 按评分/标签/评论内容生成极简在线 hints（确定性，不走 LLM）。 */
export function buildReplyGenerationHints({ rating, tags, content, replySettings }) {
  const settings = normalizeReplySettings(replySettings);
  const tagList = Array.isArray(tags) ? tags : [];
  const keys = new Set(tagList.map((t) => t?.key).filter(Boolean));
  const labels = tagList.map((t) => t?.label).filter(Boolean).join("、");

  let scenario = "一般反馈";
  if (keys.has("praise") && rating >= 4) scenario = "好评";
  else if (keys.has("feature_request")) scenario = "功能请求";
  else if (tagList.some((t) => /崩溃|闪退|卡顿|无法|bug|crash/i.test(`${t?.label ?? ""} ${t?.subLabel ?? ""}`))) {
    scenario = "缺陷/故障";
  } else if (rating <= 2) scenario = "投诉差评";
  else if (rating >= 4) scenario = "中好评";

  const contactTrigger = detectReplyContactTrigger(content, tagList);
  const email = pickContactEmail(settings.contactInfo, contactTrigger);
  let contactInstruction = null;
  if (contactTrigger && email) {
    contactInstruction = `【必须】本条涉及${contactTrigger === "refund" ? "退款/退钱" : "扣费/订阅/账号"}，回复中引导联系：${email}`;
  } else if (!settings.contactInfo.trim()) {
    contactInstruction = "未授权联系方式，禁止出现邮箱/网址/电话。";
  }

  return {
    scenario,
    contactInstruction,
    tagLabels: labels || "无",
    lengthHint: "2~4 句，约 40~120 字",
  };
}

export function buildOnlineReplySystemPrompt({ playbook }) {
  // 固定前缀 + playbook：同 App 连续生成时 DeepSeek 自动 context cache（无需额外参数）。
  return [
    "你是应用商店评论回复助手。严格遵守下方 playbook，用评论原文语言写回复。",
    "称呼纪律：有评论者昵称时只用其名字打招呼；无昵称时用中性礼貌开场。禁止兄弟/bang/bro/亲/老铁等俚语或泛称。",
    playbook,
    "只输出回复正文，不要 JSON、不要前后缀。",
  ].join("\n\n");
}

export function buildOnlineReplyUserPrompt({ author, rating, hints, content }) {
  const authorName = String(author ?? "").trim();
  const salutationHint = authorName
    ? `称呼：用「${authorName}」称呼评论者（与其语言习惯一致即可，如 Halo ${authorName}），不要 bang/bro/兄弟等。`
    : "称呼：无评论者昵称，用中性礼貌开场，勿用兄弟/亲等。";
  return [
    `场景：${hints.scenario}`,
    `评分：${rating} 星`,
    `问题类型：${hints.tagLabels}`,
    salutationHint,
    `评论：${content}`,
    hints.contactInstruction ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
