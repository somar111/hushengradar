-- ai_tag_keys：ai_tags 顶层 key 的去重索引副本，供 GIN/数组筛选加速；展示与计数以 ai_tags 为准。
alter table public.reviews add column if not exists ai_tag_keys text[];

-- 从 ai_tags 回填/修正 ai_tag_keys（幂等，可重复执行）
update public.reviews r
set ai_tag_keys = sub.keys
from (
  select
    id,
    coalesce(
      (
        select array_agg(distinct elem->>'key' order by elem->>'key')
        from jsonb_array_elements(ai_tags) as elem
        where coalesce(elem->>'key', '') <> ''
      ),
      '{}'::text[]
    ) as keys
  from public.reviews
  where ai_tags is not null and jsonb_array_length(ai_tags) > 0
) sub
where r.id = sub.id
  and (r.ai_tag_keys is null or r.ai_tag_keys is distinct from sub.keys);

-- 无标签评论：索引置空数组
update public.reviews
set ai_tag_keys = '{}'::text[]
where (ai_tags is null or jsonb_array_length(ai_tags) = 0)
  and (ai_tag_keys is null or ai_tag_keys <> '{}'::text[]);

create index if not exists reviews_ai_tag_keys_gin_idx on public.reviews using gin (ai_tag_keys);
