import { buildClassifyPrompt, buildReplyPrompt, sanitizeTagKey } from "./promptKit.mjs";

export type ClassifiedTag = { key: string; label: string };

/**
 * 通用评论分类：不针对任何具体 App。appContext 是该 App 在 apps.context 里存的背景说明，
 * 换一个 App 只需要换这段 context，不需要改这个函数或 prompt 里的固定类别。
 * existingCustomTags：这个 App 之前已经造过的自定义标签（不在 baseline 里的），传进去让模型优先复用，
 * 避免每次调用互不知情、造出一堆近义的碎标签。
 */
export async function classifyReview(opts: {
  content: string;
  rating: number;
  appContext?: string | null;
  existingCustomTags?: ClassifiedTag[];
}): Promise<ClassifiedTag[]> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = buildClassifyPrompt({
    appContext: opts.appContext,
    existingCustomTags: opts.existingCustomTags ?? [],
  });
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

  if (!Array.isArray(parsed.tags)) return [];
  // 清洗 key 格式（防止模型偶尔返回带空格/大写的 key，导致同义标签在筛选时悄悄失效）
  return parsed.tags
    .filter((t) => t && t.key && t.label)
    .map((t) => ({ key: sanitizeTagKey(t.key), label: t.label }));
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
 * 给 AI 写个性化回复建议。officialReplyExample 是这条评论下（如果有）官方真实回复过的文本，
 * 传进去让模型有真实联系方式/处理流程可参考，而不是在没有真实素材时凭空编造。
 */
export async function generateReplySuggestion(opts: {
  content: string;
  rating: number;
  author: string;
  tags: ClassifiedTag[];
  appContext?: string | null;
  officialReplyExample?: string | null;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = buildReplyPrompt({
    appContext: opts.appContext,
    officialReplyExample: opts.officialReplyExample,
  });

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
