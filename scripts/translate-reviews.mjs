// 一次性脚本：给所有评论做真实语言检测+翻译缓存，写回 detected_lang/translated_zh/translated_en。
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY;

async function detectAndTranslate(content) {
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content }],
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function main() {
  const { data: reviews, error } = await supabase
    .from("reviews")
    .select("id, content")
    .is("translated_at", null);
  if (error) throw error;
  console.log(`待翻译：${reviews.length} 条`);

  let done = 0;
  let failed = 0;
  const concurrency = 8;
  const queue = [...reviews];

  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const result = await withRetry(() => detectAndTranslate(row.content));
        const { error: updErr } = await supabase
          .from("reviews")
          .update({
            detected_lang: result.detected_lang,
            translated_zh: result.translated_zh,
            translated_en: result.translated_en,
            translated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (updErr) throw updErr;
      } catch (e) {
        failed++;
        console.error(`翻译失败 id=${row.id}:`, e.message);
      }
      done++;
      if (done % 50 === 0) console.log(`进度 ${done}/${reviews.length}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`完成。成功 ${done - failed}，失败 ${failed}。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
