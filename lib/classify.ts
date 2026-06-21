export type ClassifiedTag = { key: string; label: string };

const BASELINE_CATEGORIES = [
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
 * 通用评论分类：不针对任何具体 App。appContext 是该 App 在 apps.context 里存的背景说明，
 * 换一个 App 只需要换这段 context，不需要改这个函数或 prompt 里的固定类别。
 */
export async function classifyReview(opts: {
  content: string;
  rating: number;
  appContext?: string | null;
}): Promise<ClassifiedTag[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const baselineList = BASELINE_CATEGORIES.map((c) => `${c.key}(${c.label})`).join("、");

  const systemPrompt = [
    "你是应用商店评论分析助手，给一条用户评论打问题类型标签。",
    `常见类型供参考：${baselineList}。`,
    "如果评论内容不属于以上任何一种，可以自己创建一个新的 key（英文 snake_case）和对应的中文 label，不要硬塞进不合适的类型。",
    "一条评论可以命中多个类型，也可以是空数组（比如内容完全中立、看不出明确诉求）。",
    opts.appContext ? `这款 App 的背景信息：${opts.appContext}` : "",
    "只输出 JSON，格式：{\"tags\": [{\"key\": \"...\", \"label\": \"...\"}]}，不要输出任何其他文字。",
  ].filter(Boolean).join("\n");

  const userPrompt = `评分：${opts.rating} 星\n评论内容：${opts.content}`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API 出错：${await res.text()}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content ?? "{}";
  let parsed: { tags?: ClassifiedTag[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek 返回的不是合法 JSON：${raw}`);
  }

  return Array.isArray(parsed.tags) ? parsed.tags : [];
}

/**
 * 给一个分类标签生成真实摘要句：喂一批该标签下的真实评论样本，让 AI 概括它们具体在说什么。
 * 不让 AI 编数字（评论数由调用方用真实统计拼接在前面），只让它描述内容。
 */
export async function summarizeCluster(opts: {
  tagLabel: string;
  sampleContents: string[];
  appContext?: string | null;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = [
    `下面是一批被归类为"${opts.tagLabel}"的应用商店评论样本。`,
    "请用一句简短中文短语概括这些评论具体在说什么（比如具体哪个功能、哪个机制、哪类场景），要紧贴样本内容，不要泛泛而谈，不要编造样本里没有的细节。",
    "输出的短语要能直接接在「N 条评论」后面组成完整句子，比如「提到更新后频繁出现保存失败、文件丢失」——不要重复「评论」「条」这些字，不要加引号或多余前后缀，不要输出数字统计。",
    opts.appContext ? `这款 App 的背景信息：${opts.appContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = opts.sampleContents.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API 出错：${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

/**
 * 给 AI 写个性化回复建议（呼声雷达的核心卖点功能，跟分类共用同一个通用 prompt 思路）。
 */
export async function generateReplySuggestion(opts: {
  content: string;
  rating: number;
  author: string;
  tags: ClassifiedTag[];
  appContext?: string | null;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = [
    "你是呼声雷达的 AI 客服助手，帮助 App 开发者给应用商店用户评论写回复。",
    "回复要具体回应评论里提到的问题，语气专业、有同理心，不要用千篇一律的模板话术。",
    "用评论原文所使用的语言回复。直接输出回复正文，不要加多余的前后缀。",
    opts.appContext ? `这款 App 的背景信息：${opts.appContext}` : "",
  ].filter(Boolean).join("\n");

  const userPrompt = `评论作者：${opts.author}\n评分：${opts.rating} 星\n问题类型：${opts.tags.map((t) => t.label).join("、") || "无"}\n评论内容：${opts.content}`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.5,
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API 出错：${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}
