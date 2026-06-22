// Prompt 构建逻辑的唯一来源——lib/classify.ts（Next.js app）和 scripts/cron-fetch.mjs（独立脚本）
// 都从这里导入，避免同一段 prompt 在多个文件里重复维护、改一处漏改另一处。

// 真正跨App通用的只有这两个——"用户满意"和"用户想要新东西"是任何产品的评论都可能出现的概念，
// 跟App具体是什么完全无关，所以固定写死，且系统里其他地方（比如 buildInsightsPrompt 判断
// "投诉vs功能请求"）依赖这两个固定 key 名存在。除此之外的分类（扣费/广告/登录问题之类）
// 是具体产品形态决定的，不应该有一份全局列表——那是给所有App开的"生产力软件"特殊口子，
// 应该按 app.seed_categories（加App时AI根据这个App的context自己提议的起步分类）来定。
export const UNIVERSAL_CATEGORIES = [
  { key: "feature_request", label: "功能请求" },
  { key: "praise", label: "好评" },
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
 * @param {{ appContext?: string | null, seedCategories?: { key: string, label: string }[], existingCustomTags?: { key: string, label: string }[] }} opts
 * seedCategories：这个App专属的起步分类（加App时AI看着context提议的，不是全局共用的一份）。
 */
export function buildClassifyPrompt({ appContext, seedCategories = [], existingCustomTags = [] }) {
  const baselineList = [...UNIVERSAL_CATEGORIES, ...seedCategories].map((c) => `${c.key}(${c.label})`).join("、");
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
    "评论经常一次说好几件不相关的事（比如同时抱怨广告多、又抱怨文件丢失）——每个命中的类型都要单独给一句 evidence：只描述这条评论里跟这个类型相关的那部分内容，用简短中文转述，不要把评论里属于其他类型的内容也混进来。",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "...", "evidence": "这条评论里跟这个类型相关的具体内容，简短中文转述"}]}，不要输出任何其他文字。',
  ].filter(Boolean).join("\n");
}

/**
 * 加App时用一次：根据这款App的context，让AI提议一份这个App专属的起步分类种子
 * （比如生产力软件可能是"扣费/广告/登录问题"，MOBA游戏可能是"匹配机制/外挂/服务器延迟"）。
 * 不是全局共用的baseline——每个App应该拿到跟自己产品形态匹配的起点，不该所有App共用一份。
 */
export function buildSeedCategoriesPrompt() {
  return [
    "你是应用商店评论分析助手。给你一款App的背景信息，请提议5~8个这类产品的评论里最可能出现的问题类型，",
    "作为后续给真实评论打标签时的参考起点（模型实际打标签时不受这份列表限制，遇到不合适的可以自己造新类型）。",
    "不要包含「好评」「功能请求」这两类——这两类是系统里所有App通用的，已经固定存在，不需要你重复提议。",
    "要紧贴这款App的具体产品形态来想（比如社交App常见的可能是骚扰举报、隐私；游戏常见的可能是匹配机制、外挂、服务器延迟、社区氛围；电商常见的可能是物流、客服、商品质量），不要照抄通用软件那套（扣费/广告/登录问题）硬套到不合适的产品上。",
    "每个类型给一个英文 snake_case 的 key（全小写、下划线分隔）和对应的中文 label。",
    '只输出 JSON：{"categories": [{"key": "...", "label": "..."}]}，不要输出其他文字。',
  ].join("\n");
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
    `下面是一批被归类为"${tagLabel}"的内容样本——每条样本是某条评论里跟这个类型相关的具体内容（不是完整评论原文，已经去掉了评论里属于其他类型的部分）。`,
    "请用一句简短中文短语概括这些样本具体在说什么（比如具体哪个功能、哪个机制、哪类场景），要紧贴样本内容，不要泛泛而谈，不要编造样本里没有的细节。",
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

/**
 * 把"综合分析"面板要看的5类真实统计数字喂给AI，让AI自己判断每一类是否足够明显、值得说，
 * 并写出对应的一句话陈述——阈值判断和措辞都交给AI，前端不再自己拍样本量/差距大小的硬指标。
 * 真实数字本身放在 user message 里传（见调用方），这里只是系统指令。
 * @param {{ appContext?: string | null, timeRangeLabel: string }} opts
 */
export function buildInsightsPrompt({ appContext, timeRangeLabel }) {
  return [
    "你是应用商店评论数据分析助手。接下来会给你这款App在某个时间窗口内的真实统计数字（不是评论原文，是已经算好的真实数据），",
    "需要你对5类数据分别判断：这个模式是否足够明显、有代表性，值得作为一句「真实结论」展示给开发者看。",
    "判断要靠你自己的判断力，结合样本量大小、差距大小——样本太小、差距太小、本来就符合正常分布的，应该判断为不值得展示，返回 null，不要为了凑数硬找一个结论。",
    "如果判断值得展示，写一句中文陈述这个真实情况——只能使用给你的这些数字（可以做基本的百分比/差值计算，但不能编造新事实、不能引用没给你的数字）。",
    TONE_POLICY,
    `当前统计口径：${timeRangeLabel}。`,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    "5类判断分别是：",
    "1. versionTrend：根据 versionStats（按时间顺序排列，最后一项是当前主力版本）判断最新版本评分是否相比此前版本有明显变化。",
    "2. ratingDistribution：根据 ratingDistribution（1~5星分布）判断评分是否两极分化（好评差评都多、中评很少）。",
    "3. complaintsVsFeatureRequest：根据 tagBreakdown 判断，除了 praise（好评）和 feature_request（功能请求）之外的问题类标签合计声量，跟 feature_request 的声量相比是否有明显差距。",
    "4. replyGap：根据 tagBreakdown 里每个标签的 replyRate，对比 overallReplyRate，判断是否有某个命中量不小的标签，官方回复覆盖率明显低于整体水平。",
    "5. localeGap：根据 localeRatings 判断是否有某个样本量不小的地区，真实满意度明显落后于 overallAvgRating。",
    '只输出 JSON：{"versionTrend": "..."或null, "ratingDistribution": "..."或null, "complaintsVsFeatureRequest": "..."或null, "replyGap": "..."或null, "localeGap": "..."或null}，不要输出其他文字。',
  ].filter(Boolean).join("\n\n");
}

/**
 * "问 AI"面板用：开发者拿这款App的真实统计数字（跟 buildInsightsPrompt 喂的是同一份 metrics）追问问题。
 * 只能根据给定数字回答，数字之外的问题（比如要看某条具体评论原文）要如实说回答不了，不能编。
 */
export function buildAskPrompt({ appContext, timeRangeLabel }) {
  return [
    "你是呼声雷达的数据问答助手，开发者会就这款App的评论数据问你问题。",
    "接下来会给你这款App在某个时间窗口内的真实统计数字（标签分布、版本评分、地区评分、官方回复率等聚合数据，不是评论原文），请只根据这些数字回答。",
    "如果问题需要的信息不在给你的数字里（比如要看某条具体评论的原文、要预测未来），如实说明你现在只能看到哪些数据、这部分回答不了，不要编造或猜测。",
    TONE_POLICY,
    `当前统计口径：${timeRangeLabel}。`,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    "直接用自然语言中文回答，不要输出JSON，必要时可以分点，但不要啰嗦。",
  ].filter(Boolean).join("\n\n");
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
