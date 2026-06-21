-- 把 cron-fetch.mjs 里硬编码的全局 LOCALES 列表改成 apps 表的 per-App 配置，
-- 不同 App 真实活跃市场不一样，不该所有 App 共用一份列表。
-- 留空 = 用脚本里的默认列表兜底，所以这是非破坏性的加列，不影响现有行为。
alter table public.apps add column target_locales jsonb;

comment on column public.apps.target_locales is
  '该 App 要抓取的语言/地区批次列表，格式 [["en","us"],["id","id"],...]；为空则 cron-fetch.mjs 用内置默认列表兜底';

-- 回填 WPS Office 当前实际在用的 14 组，保证迁移后行为不变
update public.apps
set target_locales = '[
  ["en","us"], ["id","id"], ["es","mx"], ["ar","sa"], ["pt","br"], ["hi","in"],
  ["fr","fr"], ["de","de"], ["ru","ru"], ["vi","vn"], ["th","th"], ["tr","tr"],
  ["ja","jp"], ["ko","kr"]
]'::jsonb
where platform = 'google_play' and external_id = 'cn.wps.moffice_eng';
