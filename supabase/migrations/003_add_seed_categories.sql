-- 给每个 App 存它自己的"起步分类种子"，不再让所有 App 共用一份全局 BASELINE_CATEGORIES。
-- 生产力软件（扣费/广告/登录问题）跟游戏（匹配机制/外挂/延迟）的真实投诉形态完全不同，
-- 不该有一份硬编码的通用列表——具体内容由 add-app.mjs 在加 App 时根据 context 让AI提议。
-- 留空 = 还没跑过这一步（比如这次迁移之前就存在的App），分类时退化成只有 praise/feature_request
-- 两个固定通用类别 + 该App历史上已经自己造出来的 custom tags，不影响正常使用。
alter table public.apps add column seed_categories jsonb;

comment on column public.apps.seed_categories is
  '这个App专属的起步分类种子 [{"key":"...","label":"..."}]，加App时AI根据context提议；不是全局共用的';
