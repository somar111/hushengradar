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
  platform: "google_play" | "app_store" | "steam";
  external_id: string;
  display_name: string;
  context: string | null;
  last_fetched_at: string | null;
  locale_watermarks: Record<string, string>;
  // 该 App 要抓取的语言/地区批次，[lang, country] 数组；为空则 cron-fetch.mjs 用内置默认列表兜底
  target_locales: [string, string][] | null;
  // 这个App专属的起步分类种子（加App时AI根据context提议），不是全局共用的一份；
  // 为空则分类时只有 praise/feature_request 两个通用类别 + 该App历史上已造出的custom tags
  seed_categories: { key: string; label: string }[] | null;
  created_at: string;
};

// evidence：这条评论里跟这个标签相关的具体内容（简短中文转述），不是整条评论——
// 用来在"展示该标签下的真实评论"时只摆跟这个标签真正相关的部分，避免摘要被评论里其他不相关的话混进去。
// 老数据没有这个字段（分类时prompt还没要求过），消费方要自己 fallback 到完整评论内容。
export type AiTag = { key: string; label: string; evidence?: string };

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
