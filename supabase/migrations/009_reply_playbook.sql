-- App 级回复策略：离线压缩 playbook + 可版本化的 reply_settings（cron / API 自动刷新 playbook）

alter table public.apps
  add column if not exists reply_settings jsonb not null default '{}'::jsonb,
  add column if not exists reply_playbook text,
  add column if not exists reply_playbook_at timestamptz,
  add column if not exists reply_playbook_inputs_hash text;

comment on column apps.reply_settings is
  '回复建议语气/句式/联系方式等；空对象时服务端用默认策略。';

comment on column apps.reply_playbook is
  '由 context + reply_settings + terminology 离线压缩的短 playbook，在线生成时复用，避免每条评论重传长手册。';

comment on column apps.reply_playbook_inputs_hash is
  'playbook 输入指纹；context/settings/glossary 变更后 cron 或 API 触发重算。';
