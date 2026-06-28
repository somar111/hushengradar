// 回复建议 settings 纯逻辑（无 Node 依赖），服务端 / Demo 共用。

export const DEFAULT_REPLY_SETTINGS = {
  tone:
    "口语化、像真人。有昵称时回复须带上评论者名字（见用户消息里的作者/昵称），问候等开场可随语境灵活组织，勿用兄弟/bang/bro/亲等俚语或泛称。投诉先理解/致歉再说明；好评感谢、不致歉；功能请求感谢并说明已转达产品团队评估。",
  style: "2~4 句、约 40~120 字，自然简洁，不要客服模板腔。投诉/退款场景不用 emoji。",
  contactInfo:
    "退款/退订引导 refund@yourapp.com；扣费争议、试用转订阅、账号/充值问题引导 support@yourapp.com。一般体验差评或无关 bug 不附邮箱。（占位，请替换真实邮箱）",
};

export function normalizeReplySettings(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    tone: String(src.tone ?? DEFAULT_REPLY_SETTINGS.tone).trim() || DEFAULT_REPLY_SETTINGS.tone,
    style: String(src.style ?? DEFAULT_REPLY_SETTINGS.style).trim() || DEFAULT_REPLY_SETTINGS.style,
    contactInfo: String(src.contactInfo ?? DEFAULT_REPLY_SETTINGS.contactInfo).trim(),
  };
}

export function mergeReplySettings(appSettings, overrides) {
  return normalizeReplySettings({ ...normalizeReplySettings(appSettings), ...(overrides ?? {}) });
}

export function isReplySettingsEmpty(raw) {
  if (!raw || typeof raw !== "object") return true;
  return !String(raw.tone ?? "").trim() && !String(raw.style ?? "").trim() && !String(raw.contactInfo ?? "").trim();
}
