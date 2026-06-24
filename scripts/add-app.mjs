// 接入新 App 的一次性脚本：传入商店 ID，自动拉 listing 生成 context，upsert 进 apps 表。
// 跟 cron-fetch.mjs（每日增量抓取/分类/翻译）分开——这是"接入"动作，不是"更新"动作，不进定时任务。
// 用法：node scripts/add-app.mjs <platform> <externalId> [--notes "真实客服邮箱/退款政策等人工补充信息"]
import { createClient } from "@supabase/supabase-js";
import gplayPkg from "google-play-scraper";
import { buildContextPrompt, buildSeedCategoriesPrompt, sanitizeTagKey } from "../lib/promptKit.mjs";

const gplay = gplayPkg.default ?? gplayPkg;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY || !DEEPSEEK_API_KEY) {
  throw new Error("缺少环境变量：NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY / DEEPSEEK_API_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const [platform, externalId, ...rest] = process.argv.slice(2);
const notesFlagIndex = rest.indexOf("--notes");
const notes = notesFlagIndex >= 0 ? rest[notesFlagIndex + 1] : null;

if (!platform || !externalId) {
  console.error('用法：node scripts/add-app.mjs <platform> <externalId> [--notes "真实客服邮箱/退款政策等人工补充信息"]');
  process.exit(1);
}

// 商店listing抓取目前只接了 google-play-scraper；其他平台还没有对应的 listing 来源，
// 接入时只能照着这份生成逻辑手写 context（不阻塞 cron-fetch.mjs 对 app_store/steam 的支持）。
if (platform !== "google_play") {
  throw new Error(`目前只支持 google_play 自动生成 context，platform="${platform}" 需要手动在 apps 表里补 context。`);
}

async function generateContext() {
  const listing = await gplay.app({ appId: externalId });
  const systemPrompt = buildContextPrompt();
  const userPrompt = [
    `App名称：${listing.title}`,
    `分类：${listing.genre}`,
    `开发者：${listing.developer}`,
    `商店简介：${listing.summary ?? ""}`,
    `详细描述：${(listing.description ?? "").slice(0, 3000)}`,
  ].join("\n");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek生成context失败 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { displayName: listing.title, generated: data.choices[0].message.content.trim() };
}

// 这款App专属的起步分类种子——不是全局共用的一份，每款App的产品形态不同，
// 真实常见的问题类型也完全不同（生产力软件 vs 游戏 vs 电商），让AI看着context自己提议。
async function generateSeedCategories(context) {
  const systemPrompt = buildSeedCategoriesPrompt();
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `这款App的背景信息：${context}` }],
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek生成起步分类失败 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!Array.isArray(parsed.categories)) return [];
  return parsed.categories
    .filter((c) => c && c.key && c.label)
    .map((c) => ({ key: sanitizeTagKey(c.key), label: c.label }));
}

async function main() {
  const { displayName, generated } = await generateContext();
  const context = notes ? `${generated}\n\n团队补充信息：${notes}` : generated;
  const seedCategories = await generateSeedCategories(context);

  console.log(`App: ${displayName}`);
  console.log(`Context:\n${context}\n`);
  console.log(`起步分类种子：${seedCategories.map((c) => `${c.key}(${c.label})`).join("、")}\n`);

  const { error } = await supabase
    .from("apps")
    .upsert(
      {
        platform,
        external_id: externalId,
        display_name: displayName,
        context,
        seed_categories: seedCategories,
        locale_discovery: { enabled: true, minWeeklyReviews: 50, reprobeDays: 7 },
      },
      { onConflict: "platform,external_id" }
    );
  if (error) throw error;

  console.log("已写入 apps 表，下次 cron-fetch.mjs 跑的时候会自动开始抓这个 App 的评论。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
