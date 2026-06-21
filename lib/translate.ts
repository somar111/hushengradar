export type TranslationResult = {
  detectedLang: string;
  translatedZh: string | null;
  translatedEn: string | null;
};

/**
 * 检测评论真实语言（不依赖不可靠的 locale 抓取批次字段），并视情况翻译成中/英文。
 * 已经是中文的不翻译成中文，已经是英文的不翻译成英文，省 token 也避免无意义改写。
 */
export async function detectAndTranslate(content: string): Promise<TranslationResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY 未配置");
  }

  const systemPrompt = [
    "你是翻译助手。给你一条应用商店评论原文，请：",
    "1. 识别它真实使用的语言，输出 ISO 639-1 两位代码（如 en/zh/id/es/ar/pt/hi）。",
    "2. 如果原文不是中文，把它翻译成简体中文；如果原文已经是中文，translated_zh 填 null。",
    "3. 如果原文不是英文，把它翻译成英文；如果原文已经是英文，translated_en 填 null。",
    "翻译要忠实原意，不要润色、不要补充原文没有的内容。",
    '只输出 JSON：{"detected_lang": "...", "translated_zh": "..."或null, "translated_en": "..."或null}，不要输出其他文字。',
  ].join("\n");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API 出错：${await res.text()}`);
  }

  const data = await res.json();
  const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  return {
    detectedLang: parsed.detected_lang ?? "unknown",
    translatedZh: parsed.translated_zh ?? null,
    translatedEn: parsed.translated_en ?? null,
  };
}
