import { buildAskPrompt, buildInsightsPrompt, buildReplyPrompt } from "./promptKit.mjs";
import { ASK_TOOLS, executeAskTool, type AskContext } from "./askTools";

export type ClassifiedTag = { key: string; label: string; evidence?: string };

export type Insights = {
  complaintsVsFeatureRequest: string | null;
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const ASK_MAX_ROUNDS = 6;

async function callDeepSeek(apiKey: string, body: Record<string, unknown>) {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek API 出错：${await res.text()}`);
  }
  return res.json();
}

/**
 * 给 AI 写个性化回复建议。officialReplyExample 是这条评论下（如果有）官方真实回复过的文本，
 * 传进去让模型有真实联系方式/处理流程可参考，而不是在没有真实素材时凭空编造。
 */
export type ReplyContext = {
  tone?: string;
  style?: string;
  contactInfo?: string;
};

export async function generateReplySuggestion(opts: {
  content: string;
  rating: number;
  author: string;
  tags: ClassifiedTag[];
  appContext?: string | null;
  officialReplyExample?: string | null;
  replyContext?: ReplyContext | null;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = buildReplyPrompt({
    appContext: opts.appContext,
    officialReplyExample: opts.officialReplyExample,
    replyContext: opts.replyContext,
  });

  const hasAuthorizedContact = Boolean(
    opts.officialReplyExample?.trim() || opts.replyContext?.contactInfo?.trim()
  );

  const userPrompt = [
    `评论作者：${opts.author}`,
    `评分：${opts.rating} 星`,
    `问题类型：${opts.tags.map((t) => t.label).join("、") || "无"}`,
    `评论内容：${opts.content}`,
    hasAuthorizedContact ? "" : "注意：无官方回复示例且未配置自定义联系方式，禁止在回复中出现邮箱、网址、电话。",
  ].filter(Boolean).join("\n");

  const data = await callDeepSeek(apiKey, {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
  });

  const reply = data.choices?.[0]?.message?.content?.trim() || "";
  const corpus = [opts.content, opts.officialReplyExample ?? "", opts.replyContext?.contactInfo ?? ""].join("\n");
  return sanitizeUnsourcedContactInfo(reply, corpus);
}

/**
 * 给"综合分析"面板"诉求占比"的真实统计数字，让AI判断是否值得展示成一句"分析"。
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

  const data = await callDeepSeek(apiKey, {
    model: "deepseek-chat",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  const raw = data.choices?.[0]?.message?.content ?? "{}";
  let parsed: Partial<Insights>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek 返回的不是合法 JSON：${raw}`);
  }

  return {
    complaintsVsFeatureRequest: parsed.complaintsVsFeatureRequest ?? null,
  };
}

function buildAskUserMessage(opts: {
  question: string;
  latestReviewDate: string | null;
  timeRangeLabel: string;
  defaultSince?: string;
  defaultLocale?: string;
}) {
  const lines = [
    opts.latestReviewDate
      ? `数据锚点（这套数据里最新一条评论日期）：${opts.latestReviewDate.slice(0, 10)}`
      : null,
    `界面当前默认：${opts.timeRangeLabel}${
      opts.defaultSince ? `（since=${opts.defaultSince.slice(0, 10)}）` : ""
    }${opts.defaultLocale ? `，地区=${opts.defaultLocale}` : "，全部地区"}`,
    "若问题指定了更细的时间或地区，优先按问题查；未指定时工具可不传 since/locale，将使用上述默认值。",
    "回答前自检：你准备写的每一句，能否在工具结果里找到对应数字或原文？找不到就删掉或改成「数据不足」。",
    "禁止编造邮箱、网址、电话；除非评论/官方回复原文里逐字出现。",
    "",
    `开发者的问题：${opts.question}`,
  ].filter((l) => l !== null);
  return lines.join("\n");
}

function sanitizeUnsourcedContactInfo(answer: string, corpus: string): string {
  const corpusLower = corpus.toLowerCase();
  const contactRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|https?:\/\/\S+/gi;
  const isSourced = (token: string) => corpusLower.includes(token.toLowerCase());

  const unsourced = [...answer.matchAll(contactRe)]
    .map((m) => m[0])
    .filter((t) => !isSourced(t));
  if (unsourced.length === 0) return answer;

  let out = answer;
  for (const token of unsourced) {
    out = out.split(token).join("");
  }

  out = out
    .replace(/\s*(或|和|or|atau|dan)\s+(访问|kelola|manage|visit)\b[^.。\n]*/gi, "")
    .replace(/(silakan\s+)?(hubungi|contact)\s+(tim\s+)?(dukungan\s+)?(kami\s+)?(di\s+)?/gi, "")
    .replace(/(建议引导用户)?(联系|通过)\s*(或|和)?\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.，。；;!?])/g, "$1")
    .trim();

  const lines = out.split("\n").filter((line) => {
    const t = line.trim();
    if (!t) return false;
    if (t.length < 16 && /联系|hubungi|contact|订阅|subscription/i.test(t) && ![...t.matchAll(contactRe)].length) {
      return false;
    }
    return true;
  });

  const cleaned = lines.join("\n").trim();
  return cleaned || answer.replace(contactRe, "").replace(/\s{2,}/g, " ").trim();
}

function sanitizeAskAnswer(answer: string, messages: ChatMessage[]): string {
  const corpus = messages
    .filter((m) => m.role === "tool")
    .map((m) => m.content)
    .join("\n");
  return sanitizeUnsourcedContactInfo(answer, corpus);
}

/**
 * "问 AI"面板：AI 通过工具查询真实评论与统计，再基于证据回答。
 */
export async function answerQuestion(opts: {
  question: string;
  appId: string;
  appContext?: string | null;
  timeRangeLabel: string;
  latestReviewDate: string | null;
  defaultSince?: string;
  defaultLocale?: string;
}): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const ctx: AskContext = {
    appId: opts.appId,
    latestReviewDate: opts.latestReviewDate,
    defaultSince: opts.defaultSince,
    defaultLocale: opts.defaultLocale,
    timeRangeLabel: opts.timeRangeLabel,
  };

  const systemPrompt = buildAskPrompt({
    appContext: opts.appContext,
    timeRangeLabel: opts.timeRangeLabel,
    latestReviewDate: opts.latestReviewDate,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: buildAskUserMessage(opts),
    },
  ];

  for (let round = 0; round < ASK_MAX_ROUNDS; round++) {
    const data = await callDeepSeek(apiKey, {
      model: "deepseek-chat",
      messages,
      tools: ASK_TOOLS,
      tool_choice: "auto",
      temperature: 0.1,
    });

    const msg = data.choices?.[0]?.message;
    if (!msg) {
      throw new Error("DeepSeek 返回为空");
    }

    if (msg.tool_calls?.length) {
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });

      for (const tc of msg.tool_calls as ToolCall[]) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        const result = await executeAskTool(tc.function.name, args, ctx);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
      continue;
    }

    const answer = msg.content?.trim();
    if (answer) return sanitizeAskAnswer(answer, messages);
    throw new Error("DeepSeek 未返回有效回答");
  }

  throw new Error("工具调用轮次超限，请简化问题后重试");
}
