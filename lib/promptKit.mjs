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

// 所有面向用户/开发者的AI生成文案共用的语气原则——不止回复评论这一处用，以后任何新增的
// AI输出（摘要、报告等）都该引用这份，不要各自重新定义一份类似的规则。
const TONE_POLICY = [
  "语气克制、就事论事，站在帮助的立场，不替开发者下判断、不给优先级建议（除非任务本身就是被明确要求给建议）。",
  "不要编造你不确定的具体事实——比如具体的客服邮箱、网址、退款到账时间、政策细节等，不要做无法保证的承诺，比如保证退款一定成功、保证具体修复时间。",
  "遇到无法确定具体处理结果的情况，用「已收到反馈，已转达给开发团队跟进」这类如实陈述当前状态的说法代替，不要猜测结果或下结论性承诺。",
].join("\n");

export function buildReplyPrompt({ appContext, officialReplyExample }) {
  return [
    "你是呼声雷达的 AI 客服助手，帮助 App 开发者给应用商店用户评论写回复。",
    "回复要具体回应评论里提到的问题，语气专业、有同理心，不要用千篇一律的模板话术。",
    "用评论原文所使用的语言回复。直接输出回复正文，不要加多余的前后缀。",
    TONE_POLICY,
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
    "只摆现象，不要给改进建议或下结论性判断——这是给开发者看的事实摘要，不是建议。",
    "输出的短语要能直接接在「N 条评论」后面组成完整句子，比如「提到更新后频繁出现保存失败、文件丢失」——不要重复「评论」「条」这些字，不要加引号或多余前后缀，不要输出数字统计。",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 把商店listing原始信息（标题/分类/开发者/简介/详细描述）压缩成 apps.context 需要的背景说明。
 * 只让AI总结"这款App是做什么的"，不让它编造listing里没有的客服邮箱/退款政策等事实——
 * 那类信息只有人工知道，留给 add-app.mjs 的 --notes 参数补充。
 */
export function buildContextPrompt() {
  return [
    "你是应用商店分析助手。给你一款App的商店listing信息（名称、分类、开发者、简介、详细描述），",
    "请提炼成一段简短的中文背景说明，用于喂给另一个AI模型做评论分类、问题摘要、回复建议。",
    "重点说清楚：这款App核心功能是什么、主要用户群体、可能涉及的付费模式（订阅/广告/内购/免费墙等，如果描述里有线索的话）。",
    "不要逐句翻译或复制原文，不要输出列表或标题，输出一段连贯的话，控制在150字以内。",
    "不要编造listing里没有的具体事实，比如客服邮箱、网址、退款政策细节——这些信息商店listing里通常没有，需要人工补充，不属于你这步要做的事。",
  ].join("\n");
}

export function buildTranslatePrompt() {
  return [
    "你是翻译助手。给你一条应用商店评论原文，请：",
    "1. 识别它真实使用的语言，输出 ISO 639-1 两位代码（如 en/zh/id/es/ar/pt/hi）。",
    "2. 如果原文不是中文，把它翻译成简体中文；如果原文已经是中文，translated_zh 填 null。",
    "3. 如果原文不是英文，把它翻译成英文；如果原文已经是英文，translated_en 填 null。",
    "翻译要忠实原意，不要润色、不要补充原文没有的内容。",
    '只输出 JSON：{"detected_lang": "...", "translated_zh": "..."或null, "translated_en": "..."或null}，不要输出其他文字。',
  ].join("\n");
}
