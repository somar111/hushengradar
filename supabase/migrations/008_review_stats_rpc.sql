-- 聚合统计 RPC：替代 Worker 内全表分页拉取（避免 Cloudflare subrequest 上限）。
-- 标签计数口径与 accumulateTagCountsFromReview 一致：每条评论每个顶层 tag_key 计 1 次；subKey 按 ai_tags 元素计数。

CREATE OR REPLACE FUNCTION public.review_stats_locales(
  p_app_id uuid,
  p_since timestamptz DEFAULT NULL,
  p_until timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH window_filtered AS (
    SELECT review_date, locale, rating
    FROM public.reviews r
    WHERE r.app_id = p_app_id
      AND (p_since IS NULL OR r.review_date >= p_since)
      AND (p_until IS NULL OR r.review_date <= p_until)
  ),
  locale_rows AS (
    SELECT
      locale,
      COUNT(*)::int AS review_count,
      ROUND(AVG(rating)::numeric, 2) AS avg_rating
    FROM window_filtered
    WHERE locale IS NOT NULL
    GROUP BY locale
    ORDER BY avg_rating ASC
  )
  SELECT jsonb_build_object(
    'dateRange', jsonb_build_object(
      'from', (SELECT MIN(review_date) FROM window_filtered),
      'to', (SELECT MAX(review_date) FROM window_filtered)
    ),
    'locales', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'locale', locale,
            'reviewCount', review_count,
            'avgRating', avg_rating
          )
          ORDER BY avg_rating ASC
        )
        FROM locale_rows
      ),
      '[]'::jsonb
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.review_stats_bundle(
  p_app_id uuid,
  p_locale text DEFAULT NULL,
  p_since timestamptz DEFAULT NULL,
  p_until timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH window_filtered AS (
    SELECT
      id,
      rating,
      locale,
      ai_tags,
      app_version,
      official_reply,
      review_date
    FROM public.reviews r
    WHERE r.app_id = p_app_id
      AND (p_since IS NULL OR r.review_date >= p_since)
      AND (p_until IS NULL OR r.review_date <= p_until)
  ),
  scoped AS (
    SELECT *
    FROM window_filtered w
    WHERE p_locale IS NULL OR COALESCE(w.locale, 'unknown') = p_locale
  ),
  scoped_counts AS (
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE official_reply IS NOT NULL)::int AS with_reply
    FROM scoped
  ),
  window_count AS (
    SELECT COUNT(*)::int AS window_review_total FROM window_filtered
  ),
  date_range AS (
    SELECT MIN(review_date) AS dt_from, MAX(review_date) AS dt_to FROM scoped
  ),
  rating_dist AS (
    SELECT COALESCE(
      jsonb_object_agg(rating::text, cnt),
      '{}'::jsonb
    ) AS dist
    FROM (
      SELECT rating, COUNT(*)::int AS cnt
      FROM scoped
      WHERE rating BETWEEN 1 AND 5
      GROUP BY rating
    ) s
  ),
  daily_ratings AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'date', day,
          'count', cnt,
          'avgRating', avg_rating
        )
        ORDER BY day
      ),
      '[]'::jsonb
    ) AS arr
    FROM (
      SELECT
        to_char(review_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS cnt,
        ROUND(AVG(rating)::numeric, 2) AS avg_rating
      FROM scoped
      GROUP BY 1
    ) d
  ),
  locale_counts AS (
    SELECT COALESCE(jsonb_object_agg(locale, cnt), '{}'::jsonb) AS obj
    FROM (
      SELECT locale, COUNT(*)::int AS cnt
      FROM window_filtered
      WHERE locale IS NOT NULL
      GROUP BY locale
    ) l
  ),
  locale_ratings AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'locale', locale,
          'count', cnt,
          'avgRating', avg_rating
        )
        ORDER BY avg_rating ASC
      ),
      '[]'::jsonb
    ) AS arr
    FROM (
      SELECT
        locale,
        COUNT(*)::int AS cnt,
        ROUND(AVG(rating)::numeric, 2) AS avg_rating
      FROM window_filtered
      WHERE locale IS NOT NULL
      GROUP BY locale
    ) lr
  ),
  version_top AS (
    SELECT
      app_version AS version,
      COUNT(*)::int AS count,
      ROUND(AVG(rating)::numeric, 2) AS avg_rating,
      AVG(EXTRACT(EPOCH FROM review_date)) AS avg_date_epoch
    FROM scoped
    WHERE app_version IS NOT NULL AND app_version <> ''
    GROUP BY app_version
    ORDER BY count DESC
    LIMIT 12
  ),
  version_stats AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'version', version,
          'count', count,
          'avgRating', avg_rating,
          'avgDate', avg_date_epoch * 1000
        )
        ORDER BY avg_date_epoch ASC
      ),
      '[]'::jsonb
    ) AS arr
    FROM version_top
  ),
  tag_elems AS (
    SELECT
      s.id AS review_id,
      s.official_reply,
      elem->>'key' AS tag_key,
      elem->>'label' AS tag_label,
      elem->>'subKey' AS sub_key,
      elem->>'subLabel' AS sub_label
    FROM scoped s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.ai_tags, '[]'::jsonb)) AS elem
    WHERE COALESCE(elem->>'key', '') <> ''
  ),
  distinct_parent AS (
    SELECT DISTINCT review_id, tag_key FROM tag_elems
  ),
  parent_counts AS (
    SELECT
      dp.tag_key,
      MAX(te.tag_label) AS label,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE s.official_reply IS NOT NULL)::int AS replied_count
    FROM distinct_parent dp
    JOIN scoped s ON s.id = dp.review_id
    JOIN tag_elems te ON te.review_id = dp.review_id AND te.tag_key = dp.tag_key
    GROUP BY dp.tag_key
  ),
  sub_counts AS (
    SELECT
      tag_key,
      sub_key,
      MAX(sub_label) AS sub_label,
      COUNT(*)::int AS count
    FROM tag_elems
    WHERE sub_key IS NOT NULL AND sub_key <> ''
    GROUP BY tag_key, sub_key
  ),
  tag_counts AS (
    SELECT COALESCE(
      jsonb_object_agg(
        pc.tag_key,
        jsonb_build_object(
          'label', pc.label,
          'count', pc.count,
          'repliedCount', pc.replied_count,
          'subTags', COALESCE(
            (
              SELECT jsonb_object_agg(
                sc.sub_key,
                jsonb_build_object('label', sc.sub_label, 'count', sc.count)
              )
              FROM sub_counts sc
              WHERE sc.tag_key = pc.tag_key
            ),
            '{}'::jsonb
          )
        )
      ),
      '{}'::jsonb
    ) AS obj
    FROM parent_counts pc
  )
  SELECT jsonb_build_object(
    'total', (SELECT total FROM scoped_counts),
    'windowReviewTotal', (SELECT window_review_total FROM window_count),
    'dateRange', jsonb_build_object(
      'from', (SELECT dt_from FROM date_range),
      'to', (SELECT dt_to FROM date_range)
    ),
    'ratingDist', (SELECT dist FROM rating_dist),
    'dailyRatings', (SELECT arr FROM daily_ratings),
    'localeCounts', (SELECT obj FROM locale_counts),
    'localeRatings', (SELECT arr FROM locale_ratings),
    'versionStats', (SELECT arr FROM version_stats),
    'officialReplyRate', CASE
      WHEN (SELECT total FROM scoped_counts) = 0 THEN 0
      ELSE ROUND(
        ((SELECT with_reply FROM scoped_counts)::numeric / (SELECT total FROM scoped_counts)) * 1000
      ) / 10
    END,
    'tagCounts', (SELECT obj FROM tag_counts)
  );
$$;

GRANT EXECUTE ON FUNCTION public.review_stats_locales(uuid, timestamptz, timestamptz) TO service_role, anon;
GRANT EXECUTE ON FUNCTION public.review_stats_bundle(uuid, text, timestamptz, timestamptz) TO service_role;
