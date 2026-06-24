// Prompt 构建逻辑的唯一来源——lib/classify.ts（Next.js app）和 scripts/cron-fetch.mjs（独立脚本）
// 都从这里导入，避免同一段 prompt 在多个文件里重复维护、改一处漏改另一处。

// 真正跨App通用的三个——"用户满意""用户想要新东西""只是笼统骂没有具体指向"，都是任何产品
// 的评论都可能出现的概念，跟App具体是什么完全无关，所以固定写死，且系统里其他地方（比如
// buildInsightsPrompt 判断"投诉vs功能请求"）依赖这些固定 key 名存在。除此之外的分类（扣费/
// 广告/登录问题之类）是具体产品形态决定的，不该有全局列表，按 app.seed_categories（加App时
// AI根据context提议的起步分类）来定。
// vague_complaint 是"必须有子问题"这条规则的唯一例外（它本身就是"说不出具体问题"，没有子问题
// 可分）——见 buildClassifyPrompt 里的说明。
export const UNIVERSAL_CATEGORIES = [
  { key: "feature_request", label: "功能请求" },
  { key: "praise", label: "好评" },
  { key: "vague_complaint", label: "意义不明的纯抱怨" },
];

// "必须有子问题"规则的例外 key——只有这个类别允许没有 subKey
export const NO_SUBTAG_KEYS = new Set(["vague_complaint"]);

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
 * 兜底修正：prompt 已经要求模型不要把"已知顶层类型"塞进别的标签当子问题，但模型不会100%遵守。
 * 这里做确定性的二次修正——如果某条 tag 的 subKey 撞上了已知的顶层 key（baseline/seed/custom），
 * 说明这条评论本该直接命中那个顶层标签，把它提升成独立的顶层标签（如果还没有），并清掉原标签
 * 上那个 subKey，避免同一个概念同时以"顶层标签"和"另一个标签的子问题"两种身份重复存在。
 * @param {{ key: string, label: string, evidence?: string|null, subKey?: string|null, subLabel?: string|null }[]} tags
 * @param {Set<string>} knownTopLevelKeys
 */
export function dedupeCrossLevelTags(tags, knownTopLevelKeys) {
  const topKeys = new Set(tags.map((t) => t.key));
  const result = [];
  for (const t of tags) {
    if (t.subKey && knownTopLevelKeys.has(t.subKey)) {
      if (!topKeys.has(t.subKey)) {
        result.push({ key: t.subKey, label: t.subLabel || t.subKey, evidence: t.evidence ?? null, subKey: null, subLabel: null });
        topKeys.add(t.subKey);
      }
      result.push({ ...t, subKey: null, subLabel: null });
    } else {
      result.push(t);
    }
  }
  return result;
}

/**
 * @param {{
 *   appContext?: string | null,
 *   seedCategories?: { key: string, label: string }[],
 *   existingCustomTags?: { key: string, label: string }[],
 *   existingSubTags?: Record<string, { key: string, label: string }[]>,
 * }} opts
 * seedCategories：这个App专属的起步分类（加App时AI看着context提议的，不是全局共用的一份）。
 * existingSubTags：按父类型分组的、这个App之前已经造过的子问题（比如 feature_request 下
 * 已经有哪些具体请求），喂给模型优先复用，跟 existingCustomTags 是同一个道理，只是细一级。
 */
export function buildClassifyPrompt({ appContext, seedCategories = [], existingCustomTags = [], existingSubTags = {} }) {
  // seedCategories 现在是"设计好的分类体系"（taxonomy）：每个顶层类型自带它的子问题清单。
  // 分类这一步是"把评论对到这套现成体系上"，不是临场发明分类——临场发明是之前 scam≈billing
  // 这种近义顶层、以及具体评论被丢进"意义不明"的根因。运行时如果真的遇到体系里没有的，
  // existingCustomTags / existingSubTags 这套兜底机制仍然允许扩展，但应该是少数。
  const taxonomyLines = [...UNIVERSAL_CATEGORIES, ...seedCategories].map((c) => {
    const subs = Array.isArray(c.subcategories) && c.subcategories.length
      ? `　子问题：${c.subcategories.map((s) => `${s.key}(${s.label})`).join("、")}`
      : (c.key === "vague_complaint" ? "　（此类无子问题）" : "");
    return `- ${c.key}(${c.label})${subs ? "\n" + subs : ""}`;
  });
  const customList = existingCustomTags.length
    ? existingCustomTags.map((c) => `${c.key}(${c.label})`).join("、")
    : null;
  const subTagLines = Object.entries(existingSubTags)
    .filter(([, subs]) => subs.length)
    .map(([parentKey, subs]) => `  - ${parentKey} 下已有：${subs.map((s) => `${s.key}(${s.label})`).join("、")}`);

  return [
    "你是应用商店评论分析助手。下面是这款 App 已经设计好的「问题分类体系」（顶层类型 + 各自的子问题）。你的任务是把给你的这条评论对应到这套体系上。",
    "分类体系：\n" + taxonomyLines.join("\n"),
    customList
      ? `这款 App 之前还临时扩展过这些顶层类型，如果评论符合，优先复用，不要再造近义的新 key：${customList}。`
      : "",
    "用体系里已有的类型时把握一个平衡：一方面，不要造近义的新顶层类型——如果评论说的是某个已有类型的同一个底层问题、只是换了说法或情绪（比如体系里已有「未经授权扣费」，就不要再为「被骗钱/诈骗扣费」单开新类型），归到已有的那个。另一方面，也不要为了复用就硬塞——如果评论说的问题跟所有已有类型性质都明显不同（比如「偷偷安装别的软件/索要过多权限/隐私担忧」跟「崩溃」「广告」都不是一回事），硬塞会让分类明显错误，这时就应该创建一个准确的新顶层类型（英文 snake_case + 中文 label），而不是塞进不沾边的类型。判断标准：宁可新建一个准确的类型，也不要塞进一个明显不对的类型。",
    "一条评论可以命中多个类型，但每条至少命中一个。",
    "关于 vague_complaint(意义不明的纯抱怨)：只有当整条评论确实没有任何具体可定位的问题时才用它——比如只说「垃圾」「难用」「Desagradable」「一星」这种纯情绪、说不出哪里不好。注意：「广告太多」「字体太小」「要付费才能用」「导出很麻烦」「偷偷装别的软件」「老让我登录」这些都是具体问题，必须归到对应的具体类型，绝不能进 vague_complaint。vague_complaint 是互斥的：只要有任何一个具体类型命中，就不要再加 vague_complaint；用了 vague_complaint 它就必须是唯一的标签。",
    "评论常一次说好几件不相关的事——每个命中的类型都要单独给一句 evidence：只转述这条评论里跟这个类型相关的那部分内容（简短中文），不要把属于别的类型的内容混进来。",
    "除了 vague_complaint，每个命中的类型都必须再给一对 subKey/subLabel，指明在这个类型下具体是哪个子问题。优先从上面该类型列出的子问题里选；只有都不合适时才新建一个 subKey（英文 snake_case + 中文 label，命名要能被后续评论复用）。只有 vague_complaint 的 subKey/subLabel 留 null。",
    "subKey 不能跟任何顶层类型撞名——如果某个子问题其实本身就是一个顶层类型，就直接命中那个顶层类型，别塞进别的类型下面当子问题。",
    subTagLines.length
      ? `运行时还临时扩展过这些子问题，符合就优先复用：\n${subTagLines.join("\n")}`
      : "",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "...", "evidence": "...", "subKey": "..."或null, "subLabel": "..."或null}]}，不要输出任何其他文字。',
  ].filter(Boolean).join("\n");
}

/**
 * 「分类体系设计」prompt——分类前先用它，喂一批真实评论样本 + App背景，让AI一次性设计出一套
 * 连贯、不重叠的「顶层问题类型 + 各自子问题」体系。这是解决"逐条临场发明分类"导致的近义顶层
 * （scam≈billing）、具体评论被丢进"意义不明"等问题的根子：先有体系，再按体系归类。
 * 通用——任何 App 喂自己的真实评论样本即可，不针对任何具体产品。
 */
export function buildTaxonomyPrompt() {
  return [
    "你是应用商店评论分析专家。给你一款 App 的背景信息和一批真实用户评论样本，请设计一套覆盖这些评论里真实问题的「问题分类体系」，供后续逐条给评论打标签时使用。",
    "要求：",
    "1. 顶层类型要覆盖样本里反复出现的真实问题（一般 8~14 个），每个类型边界清晰、性质单一。",
    "2. 关键之一——合并近义：如果用户用不同说法（甚至不同情绪）描述的是同一个底层问题（比如「乱扣费」和「被诈骗扣钱」其实都是未经同意的扣费），必须合并成一个类型，不要拆成好几个近义类型。",
    "3. 关键之二——覆盖完整：样本里每一类反复出现的、性质明显不同的问题，都要有一个合适的归属。不要把明显不相关的问题硬塞进某个不沾边的类型（比如把「隐私/权限/被装别的软件」塞进「广告」，或把「字体/显示太小」塞进「扣费」）。如果有一类问题反复出现却不属于任何已列类型，就单独为它建一个类型——宁可多建一个准确的类型，也不要硬塞。",
    "4. 每个顶层类型下，列出样本里这个类型反复出现的具体子问题（一般 2~6 个）。",
    "5. 关键之三——不重叠：同一个具体问题只能属于一个顶层类型，同一个（或近义的）子问题不能在多个顶层类型下重复出现。如果一个问题横跨多个类型（比如「取消订阅后还在扣费」既沾「扣费」又沾「取消」），只放到最贴近用户核心痛点的那一个类型下，另一个类型不要再列。顶层类型之间、子问题之间都要互斥、不交叉。",
    "6. 不要包含「好评」「功能请求」「意义不明的纯抱怨」这三类——它们是系统通用类别，已固定存在，你不用管。",
    "7. key 用英文 snake_case（全小写、下划线分隔），label 用简短中文。",
    '只输出 JSON：{"categories": [{"key": "...", "label": "...", "subcategories": [{"key": "...", "label": "..."}]}]}，不要输出其他文字。',
  ].join("\n");
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
    "不要包含「好评」「功能请求」「意义不明的纯抱怨」这三类——它们是系统里所有App通用的，已经固定存在，不需要你重复提议。",
    "要紧贴这款App的具体产品形态来想（比如社交App常见的可能是骚扰举报、隐私；游戏常见的可能是匹配机制、外挂、服务器延迟、社区氛围；电商常见的可能是物流、客服、商品质量），不要照抄通用软件那套（扣费/广告/登录问题）硬套到不合适的产品上。",
    "每个类型给一个英文 snake_case 的 key（全小写、下划线分隔）和对应的中文 label。",
    '只输出 JSON：{"categories": [{"key": "...", "label": "..."}]}，不要输出其他文字。',
  ].join("\n");
}

// 所有面向用户/开发者的AI生成文案共用的语气原则——不止回复评论这一处用，以后任何新增的
// AI输出（摘要、报告等）都该引用这份，不要各自重新定义一份类似的规则。
const TONE_POLICY = [
  "语气克制、就事论事，站在帮助的立场，不替开发者下判断、不给优先级建议（除非任务本身就是被明确要求给建议）。",
  "注重帮助开发者解决问题，但不要说教，不要用训诫式语气（如「你应该/必须立刻」这类表达）。",
  "不要过度推断：只能基于已给数据说结论；若证据不足，用「可能/疑似/样本不足待确认」表达不确定性。",
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
    "需要你判断：除了 praise（好评）和 feature_request（功能请求）之外的问题类标签合计声量，跟 feature_request 的声量相比是否有明显差距，这个模式是否足够明显、有代表性，值得作为一句「分析」展示给开发者看。",
    "判断要靠你自己的判断力，结合样本量大小、差距大小——样本太小、差距太小、本来就符合正常分布的，应该判断为不值得展示，返回 null，不要为了凑数硬找一个结论。",
    "如果判断值得展示，写一句中文陈述这个真实情况——只能使用给你的这些数字（可以做基本的百分比/差值计算，但不能编造新事实、不能引用没给你的数字）。",
    TONE_POLICY,
    `当前统计口径：${timeRangeLabel}。`,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON：{"complaintsVsFeatureRequest": "..."或null}，不要输出其他文字。',
  ].filter(Boolean).join("\n\n");
}

/**
 * "问 AI"面板用：通过工具调用查询真实评论与统计数据，再基于证据回答。
 */
export function buildAskPrompt({ appContext, timeRangeLabel, latestReviewDate }) {
  return [
    "你是呼声雷达的数据问答助手。开发者会就这款 App 的用户评论数据提问。",
    "你可以调用工具查询真实数据：聚合统计、各地区概览、具体评论样本。",
    "回答必须基于工具返回的真实数据，引用具体现象（标签、评分、评论摘录），不要编造没查到的内容。",
    "需要了解「用户在抱怨/称赞什么」时，应结合 get_stats 的标签分布与 query_reviews 的原文样本归纳，不要只报数字。",
    "query_reviews 返回的是抽样（含 total），样本有限时如实说明。",
    "locale 是抓取批次代码，格式 lang_country（如 en_us、id_id）。不确定对应关系时先 list_locales。",
    latestReviewDate
      ? `计算「最近 N 天/这周」等相对时间时，以数据锚点（最新评论日 ${latestReviewDate.slice(0, 10)}）为终点往回推算，不要用服务器今天的日期。`
      : "",
    `界面左侧当前默认范围：${timeRangeLabel}。问题里若指定了更细的时间或地区，优先按问题查；没指定则用界面默认（见用户消息里的默认 since/locale）。`,
    TONE_POLICY,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    "必须输出结构化 Markdown（GFM）：用二级/三级标题、项目符号和短段落组织内容；不要把所有内容挤在同一行。",
    "建议格式：`## 总体概况`、`## 主要发现`、`## 真实评论证据`、`## 结论`。若数据不足，单独加 `## 数据限制` 说明。",
    "目标是帮助开发者定位并解决问题：每条发现后优先给可执行动作（产品/运营/客服），但语气保持协作，不说教。",
    "禁止使用内部术语（如「子问题」「taxonomy」「聚类」）；请改成开发者可直接理解的自然语言。",
    "不要输出 JSON。",
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
