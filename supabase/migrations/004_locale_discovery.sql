-- locale 自动探测：按「本周评论数 ≥ 阈值」筛选活跃抓取批次，结果缓存到 active_locales。
-- target_locales 非空时仍走手动模式，优先级高于 locale_discovery。
alter table public.apps add column if not exists locale_discovery jsonb;
alter table public.apps add column if not exists active_locales jsonb;
alter table public.apps add column if not exists locale_probed_at timestamptz;

comment on column public.apps.locale_discovery is
  '自动探测配置，例 {"enabled":true,"minWeeklyReviews":50,"reprobeDays":7,"candidates":[["en","us"],...]}；candidates 可省略，用脚本内置列表';
comment on column public.apps.active_locales is
  '最近一次探测通过的活跃 locale 列表，格式 [["en","us"],...]';
comment on column public.apps.locale_probed_at is
  'active_locales 上次写入时间；reprobeDays 内复用缓存，不重复探测';
