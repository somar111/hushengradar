// DeepSeek 调用的单一封装：scripts/CLI 与 taxonomy orchestrator 共用，避免每处重复 fetch。
// 默认走 JSON 模式（response_format json_object）并解析返回；taxonomy 的判断/措辞都经这里产出。
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export function createDeepSeekCaller(apiKey, { model = "deepseek-chat", temperature = 0.3 } = {}) {
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY");
  return async function callModel(systemPrompt, userPrompt, opts = {}) {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: opts.temperature ?? temperature,
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return JSON.parse(data.choices[0].message.content);
  };
}
