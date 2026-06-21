// Prompt 构建逻辑的唯一来源——lib/classify.ts（Next.js app）和 scripts/cron-fetch.mjs（独立脚本）
// 都从这里导入，避免同一段 prompt 在多个文件里重复维护、改一处漏改另一处。

export const BASELINE_CATEGORIES = [
  { key: "billing", label: "扣费/订阅投诉" },
  { key: "bug", label: "功能故障" },
  { key: "ads", label: "广告骚扰" },
  { key: "ui_regression", label: "改版体验倒退" },
  { key: "paywall", label: "付费墙限制" },
  { key: "login_sync", label: "登录/同步问题" },
  { key: "feature_request", label: "功能请求" },
  { key: "praise", label: "正面评价" },
];

/**
 * 把模型返回的 key 清洗成稳定的 snake_case，避免同义 key 因为大小写/空格不一致而在
 * ai_tag_keys 数组筛选时悄悄失效。
 */
export function sanitizeTagKey(key) {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "other";
}

/**
 * @param {{ appContext?: string | null, existingCustomTags?: { key: string, label: string }[] }} opts
 */
export function buildClassifyPrompt({ appContext, existingCustomTags = [] }) {
  const baselineList = BASELINE_CATEGORIES.map((c) => `${c.key}(${c.label})`).join("、");
  const customList = existingCustomTags.length
    ? existingCustomTags.map((c) => `${c.key}(${c.label})`).join("、")
    : null;

  return [
    "你是应用商店评论分析助手，给一条用户评论打问题类型标签。",
    `常见类型供参考：${baselineList}。`,
    customList
      ? `这款 App 之前已经创建过这些自定义类型，如果评论内容符合，优先复用这些已有的 key，不要重复造近义的新 key：${customList}。`
      : "",
    "只有在以上所有类型（常见类型 + 已有自定义类型）都不合适时，才创建新 key（必须是英文 snake_case，全小写、用下划线分隔单词）和对应的中文 label，不要硬塞进不合适的类型。",
    "一条评论可以命中多个类型，也可以是空数组（比如内容完全中立、看不出明确诉求）。",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "..."}]}，不要输出任何其他文字。',
  ].filter(Boolean).join("\n");
}

export function buildReplyPrompt({ appContext, officialReplyExample }) {
  return [
    "你是呼声雷达的 AI 客服助手，帮助 App 开发者给应用商店用户评论写回复。",
    "回复要具体回应评论里提到的问题，语气专业、有同理心，不要用千篇一律的模板话术。",
    "用评论原文所使用的语言回复。直接输出回复正文，不要加多余的前后缀。",
    "【重要】不要编造你不确定的具体事实——比如具体的客服邮箱、网址、退款到账时间、政策细节等。如果不知道真实信息，用模糊但真诚的说法代替（比如「请通过 App 内官方客服渠道联系我们」），绝对不能凭空编一个看起来合理的邮箱或网址。",
    "【重要】不要代表官方做出无法保证的承诺，比如保证退款一定成功、保证具体修复时间——只能说会跟进处理，不能下结论性承诺。",
    officialReplyExample
      ? `这条评论下官方实际回复过的真实文本（如果要提到联系方式/处理流程，优先参考这段里出现的真实信息，不要自己编）：${officialReplyExample}`
      : "",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
  ].filter(Boolean).join("\n");
}

export function buildSummaryPrompt({ tagLabel, appContext }) {
  return [
    `下面是一批被归类为"${tagLabel}"的应用商店评论样本。`,
    "请用一句简短中文短语概括这些评论具体在说什么（比如具体哪个功能、哪个机制、哪类场景），要紧贴样本内容，不要泛泛而谈，不要编造样本里没有的细节。",
    "输出的短语要能直接接在「N 条评论」后面组成完整句子，比如「提到更新后频繁出现保存失败、文件丢失」——不要重复「评论」「条」这些字，不要加引号或多余前后缀，不要输出数字统计。",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
  ].filter(Boolean).join("\n");
}
