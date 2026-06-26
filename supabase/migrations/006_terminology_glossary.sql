-- App 级产品术语表：开发者维护专名映射，供翻译 / 问 AI / 回复建议共用。
-- 默认空数组；不预填内容，由团队在 Demo 设置里自行添加。

alter table apps
  add column if not exists terminology_glossary jsonb not null default '[]'::jsonb;

comment on column apps.terminology_glossary is
  '产品专名术语表 [{"source":"...","zh":"...","en":"...","note":"..."}]，per-App，供 AI 翻译/回复/问 AI 注入';
