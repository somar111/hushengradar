// 一次性脚本：把 app/demo/data/wps-reviews.json 的真实评论导入 Supabase，
// 并用 DeepSeek 跑真实分类（替代之前的关键词正则）。
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

const APP_CONTEXT =
  "WPS Office：办公软件，包含 Word/Excel/PPT 编辑、PDF 工具、文档扫描。已知问题：有 3 天免费试用自动转年度订阅的机制，容易引发用户误以为被乱扣费的投诉。";

async function classifyReview(content, rating) {
  const baselineList =
    "billing(扣费/订阅投诉)、bug(功能故障)、ads(广告骚扰)、ui_regression(改版体验倒退)、paywall(付费墙限制)、login_sync(登录/同步问题)、feature_request(功能请求)、praise(正面评价)";
  const systemPrompt = [
    "你是应用商店评论分析助手，给一条用户评论打问题类型标签。",
    `常见类型供参考：${baselineList}。`,
    "如果评论内容不属于以上任何一种，可以自己创建一个新的 key（英文 snake_case）和对应的中文 label，不要硬塞进不合适的类型。",
    "一条评论可以命中多个类型，也可以是空数组（比如内容完全中立、看不出明确诉求）。",
    `这款 App 的背景信息：${APP_CONTEXT}`,
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "..."}]}，不要输出任何其他文字。',
  ].join("\n");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `评分：${rating} 星\n评论内容：${content}` },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return Array.isArray(parsed.tags) ? parsed.tags : [];
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
  console.log("1. 创建/获取 WPS app 记录...");
  const { data: app, error: appErr } = await supabase
    .from("apps")
    .upsert(
      {
        platform: "google_play",
        external_id: "cn.wps.moffice_eng",
        display_name: "WPS Office",
        context: APP_CONTEXT,
      },
      { onConflict: "platform,external_id" }
    )
    .select()
    .single();
  if (appErr) throw appErr;
  console.log("   app_id =", app.id);

  console.log("2. 读取本地评论数据...");
  const raw = JSON.parse(
    readFileSync(new URL("../app/demo/data/wps-reviews.json", import.meta.url), "utf8")
  );
  console.log(`   共 ${raw.length} 条`);

  console.log("3. 写入 reviews 表（去掉旧的正则 tags）...");
  const rows = raw.map((r) => ({
    id: r.id,
    app_id: app.id,
    source: r.source,
    locale: r.locale,
    author: r.author,
    rating: r.rating,
    review_date: r.date,
    app_version: r.appVersion,
    content: r.content,
    official_reply: r.officialReply,
    official_reply_date: r.officialReplyDate,
    ai_tags: [],
    ai_classified_at: null,
  }));
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from("reviews").upsert(chunk, { onConflict: "id" });
    if (error) throw error;
    console.log(`   写入 ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }

  console.log("4. 跑真实 DeepSeek 分类（并发 8）...");
  let done = 0;
  const concurrency = 8;
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      if (!row) break;
      try {
        const tags = await withRetry(() => classifyReview(row.content, row.rating));
        const { error } = await supabase
          .from("reviews")
          .update({ ai_tags: tags, ai_classified_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) throw error;
      } catch (e) {
        console.error(`   分类失败 id=${row.id}:`, e.message);
      }
      done++;
      if (done % 50 === 0) console.log(`   已分类 ${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`完成。共处理 ${done}/${rows.length} 条。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
