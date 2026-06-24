import { createClient } from "@supabase/supabase-js";

// 只在服务端用（route handler / 脚本），用 service role key，绕过 RLS
export function getServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("Supabase 环境变量未配置（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY）");
  }
  return createClient(url, key);
}

export type AppRow = {
  id: string;
  platform: "google_play" | "app_store";
  external_id: string;
  display_name: string;
  context: string | null;
  last_fetched_at: string | null;
  locale_watermarks: Record<string, string>;
  // 该 App 要抓取的语言/地区批次，[lang, country] 数组；为空则 cron-fetch.mjs 用内置默认列表兜底
  target_locales: [string, string][] | null;
  // 这个App专属的「问题分类体系」（taxonomy）：顶层类型 + 各自的子问题。由 build-taxonomy.mjs
  // 从真实评论样本设计生成（add-app 时先用商店listing生成一份粗的、无子问题的兜底）。分类时
  // 按这套体系归类，不逐条临场发明。为空则只有 praise/feature_request/vague_complaint 三个通用类别。
  seed_categories: { key: string; label: string; subcategories?: { key: string; label: string }[] }[] | null;
  // 自动探测活跃 locale：enabled 时 cron-fetch 按本周评论数阈值筛选抓取批次（见 active_locales）
  locale_discovery: {
    enabled?: boolean;
    minWeeklyReviews?: number;
    reprobeDays?: number;
    candidates?: [string, string][];
  } | null;
  active_locales: [string, string][] | null;
  locale_probed_at: string | null;
  created_at: string;
};

// evidence：这条评论里跟这个标签相关的具体内容（简短中文转述），不是整条评论——
// 用来在"展示该标签下的真实评论"时只摆跟这个标签真正相关的部分，避免摘要被评论里其他不相关的话混进去。
// 老数据没有这个字段（分类时prompt还没要求过），消费方要自己 fallback 到完整评论内容。
// subKey/subLabel：这个标签下更具体的子问题（比如 feature_request 下具体是"阿拉伯语支持"
// 还是"图片支持"），同一份分类调用里一起生成，不是单独再起一次分类。可以没有（不是每个
// 标签命中都有意义的子分类）。老数据没有这两个字段，消费方要当作"没有子分类"处理。
export type AiTag = { key: string; label: string; evidence?: string; subKey?: string | null; subLabel?: string | null };

export type ReviewRow = {
  id: string;
  app_id: string;
  source: string;
  locale: string | null;
  author: string | null;
  rating: number | null;
  review_date: string;
  app_version: string | null;
  content: string;
  official_reply: string | null;
  official_reply_date: string | null;
  ai_tags: AiTag[];
  ai_classified_at: string | null;
  fetched_at: string;
  detected_lang: string | null;
  translated_zh: string | null;
  translated_en: string | null;
  translated_at: string | null;
};

export type TagSummaryRow = {
  app_id: string;
  tag_key: string;
  summary: string;
  sample_size: number;
  generated_at: string;
};
