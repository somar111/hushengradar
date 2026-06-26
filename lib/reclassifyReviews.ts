import {
  UNIVERSAL_CATEGORIES,
  buildSubTagReusePool,
  subTagMapToPromptObject,
} from "./promptKit.mjs";
import { classifyReviewWithPipeline } from "./classifyReview.mjs";
import { getUniversalSubcategories } from "./taxonomyEnrich.mjs";
import { getServiceSupabase, type AppRow } from "./supabase";
import {
  fetchReviewsForReclassify,
  invalidateStatsCache,
  type ReviewQueryFilters,
} from "./reviews";

const UNIVERSAL_KEYS = new Set(UNIVERSAL_CATEGORIES.map((c) => c.key));
const CONCURRENCY = 6;

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error("重试失败");
}

async function runConcurrent<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
}

type ClassifyRow = { id: string; content: string; rating: number };

async function buildClassifyContext(app: AppRow) {
  const supabase = getServiceSupabase();
  const seedCategories = app.seed_categories ?? [];
  const universalSubcategories = getUniversalSubcategories(app);
  const baselineKeys = new Set([...UNIVERSAL_KEYS, ...seedCategories.map((c) => c.key)]);

  const { data: classifiedSample, error } = await supabase
    .from("reviews")
    .select("ai_tags")
    .eq("app_id", app.id)
    .not("ai_classified_at", "is", null)
    .limit(2000);
  if (error) throw error;

  const existingCustomTagsMap = new Map<string, string>();
  for (const r of classifiedSample ?? []) {
    for (const t of r.ai_tags ?? []) {
      if (!baselineKeys.has(t.key)) existingCustomTagsMap.set(t.key, t.label);
    }
  }

  const subTagReusePool = buildSubTagReusePool(
    seedCategories,
    classifiedSample ?? [],
    undefined,
    universalSubcategories
  );

  return {
    classifyPromptBase: {
      appContext: app.context,
      seedCategories,
      universalSubcategories,
    },
    baselineKeys,
    existingCustomTagsMap,
    subTagReusePool,
  };
}

export async function reclassifyReviewsMatching(app: AppRow, filters: ReviewQueryFilters) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY 未配置");

  const { reviews, total } = await fetchReviewsForReclassify(filters);
  if (!reviews.length) {
    return { total: 0, processed: 0, succeeded: 0, failed: 0, errors: [] as string[] };
  }

  const supabase = getServiceSupabase();
  const ctx = await buildClassifyContext(app);
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  await runConcurrent(reviews as ClassifyRow[], CONCURRENCY, async (r) => {
    try {
      const existingCustomTags = [...ctx.existingCustomTagsMap.entries()].map(([key, label]) => ({ key, label }));
      const existingSubTags = subTagMapToPromptObject(ctx.subTagReusePool);
      const knownTopLevelKeys = new Set([...ctx.baselineKeys, ...ctx.existingCustomTagsMap.keys()]);
      const { tags } = await withRetry(() =>
        classifyReviewWithPipeline(apiKey, {
          content: r.content,
          rating: r.rating,
          knownTopLevelKeys,
          calibrate: true,
          ...ctx.classifyPromptBase,
          existingCustomTags,
          existingSubTags,
        })
      );
      for (const t of tags) {
        if (!ctx.baselineKeys.has(t.key)) ctx.existingCustomTagsMap.set(t.key, t.label);
      }
      const { error } = await supabase
        .from("reviews")
        .update({
          ai_tags: tags,
          ai_tag_keys: tags.map((t) => t.key),
          ai_classified_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      if (error) throw error;
      succeeded++;
    } catch (e) {
      failed++;
      if (errors.length < 5) errors.push(`${r.id}: ${(e as Error).message}`);
    }
  });

  invalidateStatsCache(app.id);

  return {
    total,
    processed: reviews.length,
    succeeded,
    failed,
    errors,
  };
}
