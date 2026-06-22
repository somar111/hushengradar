import { buildAskPrompt, buildInsightsPrompt, buildReplyPrompt } from "./promptKit.mjs";

export type ClassifiedTag = { key: string; label: string; evidence?: string };

export type Insights = {
  versionTrend: string | null;
  ratingDistribution: string | null;
  complaintsVsFeatureRequest: string | null;
  replyGap: string | null;
  localeGap: string | null;
};

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

/**
 * 给"综合分析"面板的5类真实统计数字，让AI判断每一类是否值得展示成一句"真实结论"。
 * 不在这里或调用方预设样本量/差距大小的硬阈值——判不判得上由AI看真实数字决定。
 */
export async function generateInsights(opts: {
  timeRangeLabel: string;
  appContext?: string | null;
  metrics: Record<string, unknown>;
}): Promise<Insights> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = buildInsightsPrompt({ appContext: opts.appContext, timeRangeLabel: opts.timeRangeLabel });
  const userPrompt = `真实统计数字：\n${JSON.stringify(opts.metrics, null, 2)}`;

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
  let parsed: Partial<Insights>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek 返回的不是合法 JSON：${raw}`);
  }

  return {
    versionTrend: parsed.versionTrend ?? null,
    ratingDistribution: parsed.ratingDistribution ?? null,
    complaintsVsFeatureRequest: parsed.complaintsVsFeatureRequest ?? null,
    replyGap: parsed.replyGap ?? null,
    localeGap: parsed.localeGap ?? null,
  };
}

/**
 * "问 AI"面板用：拿跟 generateInsights 同一份真实统计数字，回答开发者追问的任意问题。
 * 不做开放式检索，只能根据给定的聚合数字回答——数字之外的问题prompt里会要求AI如实说回答不了。
 */
export async function answerQuestion(opts: {
  question: string;
  appContext?: string | null;
  timeRangeLabel: string;
  metrics: Record<string, unknown>;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = buildAskPrompt({ appContext: opts.appContext, timeRangeLabel: opts.timeRangeLabel });
  const userPrompt = `真实统计数字：\n${JSON.stringify(opts.metrics, null, 2)}\n\n开发者的问题：${opts.question}`;

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
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API 出错：${await res.text()}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}
