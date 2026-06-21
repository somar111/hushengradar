-- 清掉旧的 Steam-only 设计表，重建通用 schema（不绑定任何具体 App）
drop table if exists public.reviews;
drop table if exists public.apps;

create table public.apps (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('google_play', 'app_store', 'steam')),
  external_id text not null, -- 包名 / App Store ID / Steam AppID
  display_name text not null,
  context text, -- 自由文本：App 背景信息，喂给 AI 分类时作为提示词上下文，换 App 不用改代码
  last_fetched_at timestamptz, -- 增量抓取的水位线
  created_at timestamptz not null default now(),
  unique (platform, external_id)
);

create table public.reviews (
  id text primary key, -- 平台原生 review id，天然去重
  app_id uuid not null references public.apps(id) on delete cascade,
  source text not null,
  locale text, -- 抓取批次（lang_country），不代表真实评论语言
  author text,
  rating smallint check (rating between 1 and 5),
  review_date timestamptz not null,
  app_version text,
  content text not null,
  official_reply text,
  official_reply_date timestamptz,
  ai_tags jsonb default '[]'::jsonb, -- DeepSeek 真实分类结果
  ai_classified_at timestamptz,
  fetched_at timestamptz not null default now()
);

create index reviews_app_id_idx on public.reviews(app_id);
create index reviews_review_date_idx on public.reviews(review_date);
create index reviews_ai_classified_idx on public.reviews(app_id) where ai_classified_at is null;

grant all on public.apps, public.reviews to service_role, anon;
