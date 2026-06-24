-- taxonomy 全生命周期：把"何时重建/演进分类体系、是否太碎、何时重分类"从人肉一次性脚本
-- 变成管线里 AI 驱动的自治阶段。这里只加"承载状态"的列/表，判断与措辞由 AI 管线产出，
-- 运营旋钮（非判断）放 taxonomy_meta.policy，可按 App 调，不写死在代码里。
-- 全部增量、幂等：不 DROP、不重建已有表，已有数据不受影响。

-- 1) taxonomy 元信息：版本号、时间戳、运营策略旋钮
--    例：{"version":2,"revisedAt":"...","bootstrappedAt":"...",
--         "policy":{"autoBuildMinReviews":150,"reviseCooldownDays":7,"autoReclassify":false,
--                   "orphanTriggerCount":8,"fragmentTriggerCount":4,"vagueShareTrigger":0.25}}
alter table public.apps add column if not exists taxonomy_meta jsonb;

-- 2) 待执行的"破坏性重分类"提案（需重读评论才能落地的修订）。
--    非破坏性（确定性改名/合并子问题）会被自动应用，不进这里；
--    只有"需要 AI 重读受影响评论"的修订才挂在这，等人工确认或 policy.autoReclassify 放行。
--    例：{"proposedAt":"...","fromVersion":1,"toVersion":2,"reason":"...",
--         "scope":"incremental","affectedTagKeys":["..."],"changes":[...]}
alter table public.apps add column if not exists pending_reclassify jsonb;

comment on column public.apps.taxonomy_meta is
  'taxonomy 生命周期元信息：版本/时间戳/运营策略旋钮（policy）；判断与措辞由 AI 产出，不在此';
comment on column public.apps.pending_reclassify is
  '待人工确认或 autoReclassify 放行的破坏性重分类提案；非破坏性修订不进这里（自动应用）';

-- 3) taxonomy 修订历史：每次 bootstrap/revision 的完整快照 + AI 给的 diff + 当时的机械信号。
--    用于审计与回滚——非破坏性修订自动应用后仍可凭快照回退到任一历史版本。
create table if not exists public.taxonomy_revisions (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  version integer not null,
  kind text not null check (kind in ('bootstrap', 'revision', 'manual')),
  taxonomy jsonb not null,           -- 该版本完整的 seed_categories 快照
  diff jsonb,                        -- AI 产出的变更清单（含理由、remap/reclassify 标注）
  signals jsonb,                     -- 触发这次修订时的机械信号快照
  applied_remap boolean not null default false,   -- 确定性映射是否已写回 ai_tags
  created_at timestamptz not null default now(),
  unique (app_id, version)
);

create index if not exists taxonomy_revisions_app_idx on public.taxonomy_revisions(app_id);

grant all on public.taxonomy_revisions to service_role, anon;
