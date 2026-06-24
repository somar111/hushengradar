// Prompt 构建逻辑的唯一来源——lib/classify.ts（Next.js app）和 scripts/cron-fetch.mjs（独立脚本）
// 都从这里导入，避免同一段 prompt 在多个文件里重复维护、改一处漏改另一处。

// 真正跨App通用的三个——"用户满意""用户想要新东西""只是笼统骂没有具体指向"，都是任何产品
// 的评论都可能出现的概念，跟App具体是什么完全无关，所以固定写死，且系统里其他地方（比如
// buildInsightsPrompt 判断"投诉vs功能请求"）依赖这些固定 key 名存在。除此之外的分类（扣费/
// 广告/登录问题之类）是具体产品形态决定的，不该有全局列表，按 app.seed_categories（加App时
// AI根据context提议的起步分类）来定。
// vague_complaint / praise 是"必须有子问题"规则的例外——前者说不出具体问题，后者通常不必分子类。
export const UNIVERSAL_CATEGORIES = [
  { key: "feature_request", label: "功能请求" },
  { key: "praise", label: "好评" },
  { key: "vague_complaint", label: "意义不明的纯抱怨" },
];

/** 不要求 subKey 的顶层 key（子问题 count 恒等式也不适用） */
export const NO_SUBTAG_KEYS = new Set(["vague_complaint", "praise"]);

/** 模型分类失败或校验仍不通过时的最大重试次数（不含首次） */
export const CLASSIFY_RETRY_ATTEMPTS = 1;

/**
 * 把模型返回的 key 清洗成稳定的 snake_case，避免同义 key 因为大小写/空格不一致而在
 * ai_tag_keys 数组筛选时悄悄失效。
 */
export function sanitizeTagKey(key) {
  return String(key)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "other";
}

/**
 * 兜底修正：prompt 已经要求模型不要把"已知顶层类型"塞进别的标签当子问题，但模型不会100%遵守。
 * 这里做确定性的二次修正——如果某条 tag 的 subKey 撞上了已知的顶层 key（baseline/seed/custom），
 * 说明这条评论本该直接命中那个顶层标签，把它提升成独立的顶层标签（如果还没有），并清掉原标签
 * 上那个 subKey，避免同一个概念同时以"顶层标签"和"另一个标签的子问题"两种身份重复存在。
 * @param {{ key: string, label: string, evidence?: string|null, subKey?: string|null, subLabel?: string|null }[]} tags
 * @param {Set<string>} knownTopLevelKeys
 */
export function dedupeCrossLevelTags(tags, knownTopLevelKeys) {
  const topKeys = new Set(tags.map((t) => t.key));
  const result = [];
  for (const t of tags) {
    if (t.subKey && knownTopLevelKeys.has(t.subKey)) {
      if (!topKeys.has(t.subKey)) {
        result.push({ key: t.subKey, label: t.subLabel || t.subKey, evidence: t.evidence ?? null, subKey: null, subLabel: null });
        topKeys.add(t.subKey);
      }
      result.push({ ...t, subKey: null, subLabel: null });
    } else {
      result.push(t);
    }
  }
  return result;
}

const GENERAL_SUBTAG = { subKey: "general", subLabel: "其他" };

/** 顶层类型是否必须有 subKey（用于单条校验与聚合恒等式） */
export function tagRequiresSubKey(key) {
  return !NO_SUBTAG_KEYS.has(key);
}

/** 比较 label 用：去空白与常见标点，不做语义推理 */
export function normalizeComparableText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、；：""''（）()[\]【】]/g, "");
}

/** 中文近义：相同汉字 multiset（如「匹配不公平」与「不公平匹配」） */
function cjkCharMultisetKey(text) {
  const s = normalizeComparableText(text).replace(/[^a-z\u4e00-\u9fff]/g, "");
  if (s.length < 3) return "";
  return [...s].sort().join("");
}

/** 两个 label 是否近义（分类校验与聚合合并共用） */
export function labelsTooSimilar(parentLabel, childText) {
  const a = normalizeComparableText(parentLabel);
  const b = normalizeComparableText(childText);
  if (!a || !b) return false;
  if (a === b) return true;
  const stripOther = (s) => s.replace(/^其他/, "");
  const ao = stripOther(a);
  const bo = stripOther(b);
  if (ao === b || bo === a || ao === bo) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 2 && (a.includes(b) || b.includes(a))) return true;
  const mkA = cjkCharMultisetKey(a);
  const mkB = cjkCharMultisetKey(b);
  if (mkA && mkA === mkB) return true;
  return false;
}

/**
 * @typedef {{ key: string, label: string, evidence?: string|null, subKey?: string|null, subLabel?: string|null }} ClassifiedTag
 */

/** 解析模型返回的 tags 数组（仅清洗字段，不做业务规则） */
export function parseClassifyTagsFromModel(parsedTags) {
  if (!Array.isArray(parsedTags)) return [];
  return parsedTags
    .filter((t) => t && t.key && t.label)
    .map((t) => ({
      key: sanitizeTagKey(t.key),
      label: String(t.label).trim(),
      evidence: t.evidence ? String(t.evidence).trim() : null,
      subKey: t.subKey ? sanitizeTagKey(t.subKey) : null,
      subLabel: t.subLabel ? String(t.subLabel).trim() : null,
    }));
}

/** 模型完全没给出可用标签时的兜底（保证规则 1：至少一个标签） */
export function fallbackTagsForRating(rating) {
  if ((rating ?? 0) >= 4) {
    return [{ key: "praise", label: "好评", evidence: null, subKey: null, subLabel: null }];
  }
  return [{ key: "vague_complaint", label: "意义不明的纯抱怨", evidence: null, subKey: null, subLabel: null }];
}

function ensureSubTagOnTag(tag) {
  if (!tagRequiresSubKey(tag.key)) {
    return { ...tag, subKey: null, subLabel: null };
  }
  if (tag.subKey && !SUBTAG_REUSE_EXCLUDE_KEYS.has(tag.subKey)) {
    return { ...tag, subLabel: tag.subLabel || tag.subKey };
  }
  return { ...tag, ...GENERAL_SUBTAG };
}

function fixParentChildNaming(tag, knownTopLevelKeys) {
  if (!tagRequiresSubKey(tag.key)) {
    return { ...tag, subKey: null, subLabel: null };
  }
  if (!tag.subKey) return ensureSubTagOnTag(tag);
  if (
    tag.subKey === tag.key
    || knownTopLevelKeys.has(tag.subKey)
    || labelsTooSimilar(tag.label, tag.subLabel || tag.subKey)
  ) {
    return { ...tag, ...GENERAL_SUBTAG };
  }
  return tag;
}

/**
 * 单条评论分类结果的确定性收尾：互斥、撞名修正、子问题兜底、去重。
 * @param {unknown} rawTags 模型 JSON 里的 tags，或已 parse 的数组
 * @param {{ knownTopLevelKeys?: Set<string>, rating?: number }} [opts]
 * @returns {ClassifiedTag[]}
 */
export function finalizeClassifiedTags(rawTags, { knownTopLevelKeys, rating } = {}) {
  const known = knownTopLevelKeys ?? new Set();
  let tags = Array.isArray(rawTags) && rawTags[0]?.key
    ? rawTags.map((t) => ({ ...t, key: sanitizeTagKey(t.key) }))
    : parseClassifyTagsFromModel(rawTags);

  if (!tags.length) tags = fallbackTagsForRating(rating);

  tags = tags.map((t) => ensureSubTagOnTag(t));
  if (tags.length > 1 && tags.some((t) => t.key === "vague_complaint")) {
    tags = tags.filter((t) => t.key !== "vague_complaint");
  }
  tags = dedupeCrossLevelTags(tags, known);
  tags = tags.map((t) => fixParentChildNaming(t, known));
  tags = tags.map((t) => ensureSubTagOnTag(t));

  const seen = new Set();
  tags = tags.filter((t) => {
    const id = `${t.key}\0${t.subKey ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (!tags.length) tags = fallbackTagsForRating(rating);

  const validation = validateClassifiedTags(tags, known);
  if (!validation.ok) tags = fallbackTagsForRating(rating);

  return tags;
}

/**
 * 校验单条评论的标签集（确定性规则，不调用模型）。
 * @param {ClassifiedTag[]} tags
 * @param {Set<string>} [knownTopLevelKeys]
 */
export function validateClassifiedTags(tags, knownTopLevelKeys = new Set()) {
  const errors = [];
  if (!tags.length) errors.push("empty");

  for (const t of tags) {
    if (!t.key || !t.label) errors.push("missing_key_or_label");

    if (tagRequiresSubKey(t.key)) {
      if (!t.subKey) errors.push(`missing_subKey:${t.key}`);
      else if (t.subKey === t.key) errors.push(`subKey_eq_parent:${t.key}`);
      else if (knownTopLevelKeys.has(t.subKey)) errors.push(`subKey_is_top_level:${t.subKey}`);
      else if (labelsTooSimilar(t.label, t.subLabel || t.subKey)) errors.push(`similar_labels:${t.key}`);
    } else if (t.subKey) {
      errors.push(`unexpected_subKey:${t.key}`);
    }
  }

  if (tags.some((t) => t.key === "vague_complaint") && tags.length > 1) {
    errors.push("vague_complaint_not_exclusive");
  }

  return { ok: errors.length === 0, errors };
}

/** 从评论列表构建 tagCounts（与 lib/reviews.computeStats 同结构，供聚合校验复用） */
export function buildTagCountsFromReviews(reviews) {
  /** @type {Record<string, { label: string, count: number, subTags: Record<string, { label: string, count: number }> }>} */
  const tagCounts = {};
  for (const r of reviews) {
    for (const t of r.ai_tags ?? []) {
      if (!t?.key) continue;
      const entry = tagCounts[t.key] ?? { label: t.label, count: 0, subTags: {} };
      entry.count++;
      if (t.subKey) {
        const sub = entry.subTags[t.subKey] ?? { label: t.subLabel || t.subKey, count: 0 };
        sub.count++;
        entry.subTags[t.subKey] = sub;
      }
      tagCounts[t.key] = entry;
    }
  }
  for (const entry of Object.values(tagCounts)) {
    entry.subTags = mergeSimilarSubTags(entry.subTags);
  }
  return tagCounts;
}

/**
 * 规则 3：需要子问题的顶层，子问题 count 之和应等于母问题 count。
 * 返回不一致项（多为历史脏数据；新分类经 finalizeClassifiedTags 后应满足）。
 */
export function findTagCountInconsistencies(tagCounts) {
  const issues = [];
  for (const [key, t] of Object.entries(tagCounts ?? {})) {
    if (!tagRequiresSubKey(key)) continue;
    const subSum = Object.values(t.subTags ?? {}).reduce((n, s) => n + s.count, 0);
    if (subSum !== t.count) {
      issues.push({ key, label: t.label, parentCount: t.count, subSum });
    }
  }
  return issues;
}

/**
 * 聚合展示用：合并同一父类下 label 近义的 subTag（保留 count 更高者的 key/label，累加 count）。
 * @param {Record<string, { label: string, count: number }>} subTags
 */
export function mergeSimilarSubTags(subTags) {
  const items = Object.entries(subTags ?? {}).map(([key, v]) => ({
    key,
    label: v.label,
    count: v.count,
  }));
  if (items.length <= 1) return subTags ?? {};

  items.sort((a, b) => b.count - a.count);
  const groups = [];
  for (const item of items) {
    const hit = groups.find((g) => labelsTooSimilar(g.label, item.label));
    if (hit) hit.count += item.count;
    else groups.push({ key: item.key, label: item.label, count: item.count });
  }
  return Object.fromEntries(groups.map((g) => [g.key, { label: g.label, count: g.count }]));
}

/** classifyReview 兜底用的泛化 subKey，不进「优先复用」池 */
export const SUBTAG_REUSE_EXCLUDE_KEYS = new Set(["general"]);

/** 历史评论里某个 subKey 至少出现几次，才进入分类时的「优先复用」列表 */
export const SUBTAG_REUSE_MIN_COUNT = 5;

/** 从 apps.seed_categories 提取 taxonomy 里设计的子问题（始终进入复用池） */
export function subTagsFromSeedCategories(seedCategories) {
  const map = new Map();
  for (const c of seedCategories ?? []) {
    if (!c?.key || !Array.isArray(c.subcategories) || !c.subcategories.length) continue;
    const subs = new Map();
    for (const s of c.subcategories) {
      if (!s?.key || !s?.label) continue;
      const key = sanitizeTagKey(s.key);
      if (SUBTAG_REUSE_EXCLUDE_KEYS.has(key)) continue;
      subs.set(key, s.label);
    }
    if (subs.size) map.set(c.key, subs);
  }
  return map;
}

/** 统计已分类评论里各父标签下的 subKey 出现次数 */
export function countSubTagsInReviews(reviews) {
  const counts = new Map();
  for (const r of reviews) {
    for (const t of r.ai_tags ?? []) {
      if (!t?.subKey || SUBTAG_REUSE_EXCLUDE_KEYS.has(t.subKey)) continue;
      const byParent = counts.get(t.key) ?? new Map();
      const entry = byParent.get(t.subKey) ?? { label: t.subLabel || t.subKey, count: 0 };
      entry.count++;
      if (t.subLabel) entry.label = t.subLabel;
      byParent.set(t.subKey, entry);
      counts.set(t.key, byParent);
    }
  }
  return counts;
}

/**
 * 分类时喂给模型的「优先复用」子问题池：
 * 1. seed_categories 里 taxonomy 设计的子问题（随时可人工/build-taxonomy 修订）
 * 2. 历史评论里已稳定出现（>= minCount 次）的 subKey
 * 不含本轮分类现场新造的 subKey——避免早期噪声立刻传染全库。
 */
export function buildSubTagReusePool(seedCategories, classifiedReviews, minCount = SUBTAG_REUSE_MIN_COUNT) {
  const pool = new Map([...subTagsFromSeedCategories(seedCategories).entries()].map(([k, v]) => [k, new Map(v)]));
  const counts = countSubTagsInReviews(classifiedReviews);
  for (const [parentKey, subs] of counts) {
    const merged = pool.get(parentKey) ?? new Map();
    for (const [subKey, { label, count }] of subs) {
      if (count < minCount || merged.has(subKey)) continue;
      merged.set(subKey, label);
    }
    if (merged.size) pool.set(parentKey, merged);
  }
  return pool;
}

export function subTagMapToPromptObject(map) {
  return Object.fromEntries(
    [...map.entries()].map(([parentKey, subs]) => [
      parentKey,
      [...subs.entries()].map(([key, label]) => ({ key, label })),
    ])
  );
}

/**
 * 把评论里已稳定出现的 subTag 合并进 seed_categories（只追加，不删改已有项）。
 * 用于 taxonomy 修订：跑完一批分类后，把反复出现的子问题写回 apps.seed_categories。
 */
export function mergeObservedSubTagsIntoTaxonomy(seedCategories, classifiedReviews, minCount = SUBTAG_REUSE_MIN_COUNT) {
  const counts = countSubTagsInReviews(classifiedReviews);
  const byParentKey = new Map((seedCategories ?? []).map((c) => [c.key, c]));
  let added = 0;

  for (const [parentKey, subs] of counts) {
    const cat = byParentKey.get(parentKey);
    if (!cat) continue;
    const existing = new Set((cat.subcategories ?? []).map((s) => sanitizeTagKey(s.key)));
    const subcategories = [...(cat.subcategories ?? [])];
    for (const [subKey, { label, count }] of subs) {
      if (count < minCount || existing.has(subKey)) continue;
      subcategories.push({ key: subKey, label });
      existing.add(subKey);
      added++;
    }
    cat.subcategories = subcategories;
  }

  return { taxonomy: [...byParentKey.values()], added };
}

/**
 * @param {{
 *   appContext?: string | null,
 *   seedCategories?: { key: string, label: string }[],
 *   existingCustomTags?: { key: string, label: string }[],
 *   existingSubTags?: Record<string, { key: string, label: string }[]>,
 * }} opts
 * seedCategories：这个App专属的起步分类（加App时AI看着context提议的，不是全局共用的一份）。
 * existingSubTags：按父类型分组的、可优先复用的子问题——来自 taxonomy 子问题清单 + 历史里
 * 已稳定出现的 subKey，不含分类过程中现场新造的（见 buildSubTagReusePool）。
 */
export function buildClassifyPrompt({ appContext, seedCategories = [], existingCustomTags = [], existingSubTags = {} }) {
  // seedCategories 现在是"设计好的分类体系"（taxonomy）：每个顶层类型自带它的子问题清单。
  // 分类这一步是"把评论对到这套现成体系上"，不是临场发明分类——临场发明是之前 scam≈billing
  // 这种近义顶层、以及具体评论被丢进"意义不明"的根因。运行时如果真的遇到体系里没有的，
  // existingCustomTags / existingSubTags 这套兜底机制仍然允许扩展，但应该是少数。
  const taxonomyLines = [...UNIVERSAL_CATEGORIES, ...seedCategories].map((c) => {
    const subs = Array.isArray(c.subcategories) && c.subcategories.length
      ? `　子问题：${c.subcategories.map((s) => `${s.key}(${s.label})`).join("、")}`
      : (NO_SUBTAG_KEYS.has(c.key) ? "　（此类无子问题）" : "");
    return `- ${c.key}(${c.label})${subs ? "\n" + subs : ""}`;
  });
  const customList = existingCustomTags.length
    ? existingCustomTags.map((c) => `${c.key}(${c.label})`).join("、")
    : null;
  const subTagLines = Object.entries(existingSubTags)
    .filter(([, subs]) => subs.length)
    .map(([parentKey, subs]) => `  - ${parentKey} 下已有：${subs.map((s) => `${s.key}(${s.label})`).join("、")}`);

  return [
    "你是应用商店评论分析助手。下面是这款 App 已经设计好的「问题分类体系」（顶层类型 + 各自的子问题）。你的任务是把给你的这条评论对应到这套体系上。",
    "分类体系：\n" + taxonomyLines.join("\n"),
    customList
      ? `这款 App 之前还临时扩展过这些顶层类型，如果评论符合，优先复用，不要再造近义的新 key：${customList}。`
      : "",
    "用体系里已有的类型时把握一个平衡：一方面，不要造近义的新顶层类型——如果评论说的是某个已有类型的同一个底层问题、只是换了说法或情绪（比如体系里已有「未经授权扣费」，就不要再为「被骗钱/诈骗扣费」单开新类型），归到已有的那个。另一方面，也不要为了复用就硬塞——如果评论说的问题跟所有已有类型性质都明显不同（比如「偷偷安装别的软件/索要过多权限/隐私担忧」跟「崩溃」「广告」都不是一回事），硬塞会让分类明显错误，这时就应该创建一个准确的新顶层类型（英文 snake_case + 中文 label），而不是塞进不沾边的类型。判断标准：宁可新建一个准确的类型，也不要塞进一个明显不对的类型。",
    "一条评论可以命中多个类型，但每条至少命中一个。",
    "关于 vague_complaint(意义不明的纯抱怨)：只有当整条评论确实没有任何具体可定位的问题时才用它——比如只说「垃圾」「难用」「Desagradable」「一星」这种纯情绪、说不出哪里不好。注意：「广告太多」「字体太小」「要付费才能用」「导出很麻烦」「偷偷装别的软件」「老让我登录」这些都是具体问题，必须归到对应的具体类型，绝不能进 vague_complaint。vague_complaint 是互斥的：只要有任何一个具体类型命中，就不要再加 vague_complaint；用了 vague_complaint 它就必须是唯一的标签。",
    "评论常一次说好几件不相关的事——每个命中的类型都要单独给一句 evidence：只转述这条评论里跟这个类型相关的那部分内容（简短中文），不要把属于别的类型的内容混进来。",
    "除了 vague_complaint 和 praise，每个命中的类型都必须再给一对 subKey/subLabel，指明在这个类型下具体是哪个子问题。",
    "子问题纪律：① 必须优先从该类型 taxonomy 子问题清单、或下方「已确认子问题」里复用已有 subKey/subLabel，不要换说法再造一个。② 禁止为同一概念造近义 subKey——例如已有「不公平匹配」就不要再建「匹配不公平」「匹配机制不公」；已有「高延迟」就不要再建「延迟高」「网络延迟大」。③ 只有现有子问题都确实无法覆盖时，才新建一个简短、可复用的 subKey（英文 snake_case + 中文 label）。vague_complaint 和 praise 的 subKey/subLabel 必须留 null。",
    "subKey 不能与任何顶层类型的 key 相同，子问题的 label 也不能与母类型的 label 相同或过于近似（否则应归并为同一类型，而不是母子重复）。如果某个子问题其实本身就是一个顶层类型，就直接命中那个顶层类型，别塞进别的类型下面当子问题。",
    subTagLines.length
      ? `以下子问题已在 taxonomy 或历史评论中稳定出现，符合就必须优先复用（禁止造近义新 subKey）：\n${subTagLines.join("\n")}`
      : "",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "...", "evidence": "...", "subKey": "..."或null, "subLabel": "..."或null}]}，不要输出任何其他文字。',
  ].filter(Boolean).join("\n");
}

/**
 * 「分类体系设计」prompt——分类前先用它，喂一批真实评论样本 + App背景，让AI一次性设计出一套
 * 连贯、不重叠的「顶层问题类型 + 各自子问题」体系。这是解决"逐条临场发明分类"导致的近义顶层
 * （scam≈billing）、具体评论被丢进"意义不明"等问题的根子：先有体系，再按体系归类。
 * 通用——任何 App 喂自己的真实评论样本即可，不针对任何具体产品。
 */
export function buildTaxonomyPrompt() {
  return [
    "你是应用商店评论分析专家。给你一款 App 的背景信息和一批真实用户评论样本，请设计一套覆盖这些评论里真实问题的「问题分类体系」，供后续逐条给评论打标签时使用。",
    "要求：",
    "1. 顶层类型要覆盖样本里反复出现的真实问题（一般 8~14 个），每个类型边界清晰、性质单一。",
    "2. 关键之一——合并近义：如果用户用不同说法（甚至不同情绪）描述的是同一个底层问题（比如「乱扣费」和「被诈骗扣钱」其实都是未经同意的扣费），必须合并成一个类型，不要拆成好几个近义类型。",
    "3. 关键之二——覆盖完整：样本里每一类反复出现的、性质明显不同的问题，都要有一个合适的归属。不要把明显不相关的问题硬塞进某个不沾边的类型（比如把「隐私/权限/被装别的软件」塞进「广告」，或把「字体/显示太小」塞进「扣费」）。如果有一类问题反复出现却不属于任何已列类型，就单独为它建一个类型——宁可多建一个准确的类型，也不要硬塞。",
    "4. 每个顶层类型下，列出样本里这个类型反复出现的具体子问题（一般 2~6 个）。",
    "5. 关键之三——不重叠：同一个具体问题只能属于一个顶层类型，同一个（或近义的）子问题不能在多个顶层类型下重复出现。如果一个问题横跨多个类型（比如「取消订阅后还在扣费」既沾「扣费」又沾「取消」），只放到最贴近用户核心痛点的那一个类型下，另一个类型不要再列。顶层类型之间、子问题之间都要互斥、不交叉。",
    "6. 不要包含「好评」「功能请求」「意义不明的纯抱怨」这三类——它们是系统通用类别，已固定存在，你不用管。",
    "7. key 用英文 snake_case（全小写、下划线分隔），label 用简短中文。",
    '只输出 JSON：{"categories": [{"key": "...", "label": "...", "subcategories": [{"key": "...", "label": "..."}]}]}，不要输出其他文字。',
  ].join("\n");
}

/**
 * 「taxonomy 修订」prompt——已经有一套分类体系、也跑过一批真实分类之后，让 AI 基于
 * 「当前体系 + 实时标签分布信号」判断这套体系是否还合身，并产出一份**结构化修订提案**。
 *
 * 这是把"何时重建/是否太碎/哪些子问题该合并/要不要新增类目"从人肉拍板搬进 AI 管线的核心：
 * 判断（verdict）与措辞（新 label/key/理由）都由模型产出，代码只负责机械地应用。
 *
 * 关键约束——每条变更必须自报「落地代价」consequence：
 *   - "remap"：纯改名/合并子问题/固化稳定子问题等，可用确定性映射直接改写已有 ai_tags，
 *              不需要重读评论。模型必须给出 remap 映射（match→set）。这类自动应用。
 *   - "reclassify"：类目拆分/新增可能涵盖老评论的母类/重新分配等，必须重读受影响评论才能落地。
 *              模型给出 affectedKeys（哪些现有顶层 key 下的评论需要重读）。这类不自动跑，
 *              挂到待确认队列，等人工放行或 policy.autoReclassify。
 *
 * 通用——任何 App 喂自己的当前体系 + 真实分布信号即可，不针对任何具体产品。
 */
export function buildTaxonomyRevisionPrompt() {
  return [
    "你是应用商店评论分析体系的「分类体系维护者」。这款 App 已经有一套「问题分类体系」（顶层类型 + 各自子问题），并已按它给一批真实评论打过标签。",
    "现在给你：当前体系、每个类型/子问题的真实命中量、模型在打标签时临时造出但还没进体系的「孤儿顶层标签」及其量、疑似近义或过碎的子问题、以及落入「意义不明的纯抱怨(vague_complaint)」的比例。",
    "你的任务：判断这套体系是否还合身，需要的话产出一份**克制、高置信度**的修订提案。不要为了改而改——没有明显问题就直接判定无需修订。",
    "防噪声纪律（最高优先级）：只对『有足够命中量且跨多天反复出现』的稳定模式动手。给你的信号已带命中量和跨越天数——命中量小、或集中在很短时间窗（疑似某一批评论或单次重分类造成的临时噪声）的，一律不要据此新增/拆分/合并类目；宁可放着不动，真问题会随时间继续累积、下次自然达标再处理。绝不能让早期或单批的临时标签噪声被固化进权威体系。",
    "应当修订的典型信号：① 同一底层问题被拆成多个近义子问题（该合并）；② 大量、且跨时间持续地落在「孤儿顶层标签」或 vague_complaint，说明体系缺了某个真实类目（该新增/拆分）；③ 某子问题已稳定大量、跨时间出现却还没进体系（该固化）；④ 某 label 措辞不准或与母类重名（该改名）。",
    "每条变更必须标注「落地代价」consequence，二选一：",
    "  - \"remap\"：改名(rename_label)、合并近义子问题(merge_subcategories)、固化已稳定出现的子问题(promote_subcategory)——这些能用确定性映射直接改写已有标签，不需要重读评论。这时必须在 remap 数组里给出映射：每项 {\"match\":{\"key\":\"...\",\"subKey\":\"...\"或null},\"set\":{可选 key/label/subKey/subLabel}}，表示把命中 match 的已有标签字段改成 set。",
    "  - \"reclassify\"：新增顶层类目(add_category)、拆分类目(split_category)、删除/合并顶层类目(merge_categories/drop_category)等——这些要重读评论才能正确归类。这时给出 affectedKeys：哪些现有顶层 key（含 vague_complaint）下的评论需要被重读。不要给 remap。",
    "判断 remap 还是 reclassify 的准绳：如果旧标签能被一条确定规则唯一映射到新标签，就是 remap；只要需要『看评论内容才能决定归到哪』，就是 reclassify。拿不准时选 reclassify，宁可走人工确认也不要错改数据。",
    "taxonomy 字段必须是修订后的**完整**体系（不是增量），沿用与输入相同的结构：[{\"key\",\"label\",\"subcategories\":[{\"key\",\"label\"}]}]；key 用英文 snake_case，label 用简短中文；顶层类型之间、子问题之间互斥不重叠；不要包含 praise/feature_request/vague_complaint 这三个系统通用类。",
    "若判定无需修订，verdict 填 \"ok\"，taxonomy 原样返回当前体系，changes 为空数组。",
    '只输出 JSON：{"verdict":"ok"或"revise","reason":"简短中文","taxonomy":[...],"changes":[{"type":"...","consequence":"remap"或"reclassify","reason":"简短中文","remap":[{"match":{"key":"...","subKey":null},"set":{"label":"..."}}],"affectedKeys":["..."]}]}，不要输出其他文字。',
  ].join("\n");
}

/**
 * 加App时用一次：根据这款App的context，让AI提议一份这个App专属的起步分类种子
 * （比如生产力软件可能是"扣费/广告/登录问题"，MOBA游戏可能是"匹配机制/外挂/服务器延迟"）。
 * 不是全局共用的baseline——每个App应该拿到跟自己产品形态匹配的起点，不该所有App共用一份。
 */
export function buildSeedCategoriesPrompt() {
  return [
    "你是应用商店评论分析助手。给你一款App的背景信息，请提议5~8个这类产品的评论里最可能出现的问题类型，",
    "作为后续给真实评论打标签时的参考起点（模型实际打标签时不受这份列表限制，遇到不合适的可以自己造新类型）。",
    "不要包含「好评」「功能请求」「意义不明的纯抱怨」这三类——它们是系统里所有App通用的，已经固定存在，不需要你重复提议。",
    "要紧贴这款App的具体产品形态来想（比如社交App常见的可能是骚扰举报、隐私；游戏常见的可能是匹配机制、外挂、服务器延迟、社区氛围；电商常见的可能是物流、客服、商品质量），不要照抄通用软件那套（扣费/广告/登录问题）硬套到不合适的产品上。",
    "每个类型给一个英文 snake_case 的 key（全小写、下划线分隔）和对应的中文 label。",
    '只输出 JSON：{"categories": [{"key": "...", "label": "..."}]}，不要输出其他文字。',
  ].join("\n");
}

// 所有面向用户/开发者的AI生成文案共用的语气原则——不止回复评论这一处用，以后任何新增的
// AI输出（摘要、报告等）都该引用这份，不要各自重新定义一份类似的规则。
const TONE_POLICY = [
  "语气克制、就事论事，站在帮助的立场，不替开发者下判断、不给优先级建议（除非任务本身就是被明确要求给建议）。",
  "注重帮助开发者解决问题，但不要说教，不要用训诫式语气（如「你应该/必须立刻」这类表达）。",
  "不要过度推断：只能基于已给数据说结论；若证据不足，用「可能/疑似/样本不足待确认」表达不确定性。",
  "不要编造你不确定的具体事实——比如具体的客服邮箱、网址、退款到账时间、政策细节等，不要做无法保证的承诺，比如保证退款一定成功、保证具体修复时间。",
  "遇到无法确定具体处理结果的情况，用「已收到反馈，已转达给开发团队跟进」这类如实陈述当前状态的说法代替，不要猜测结果或下结论性承诺。",
].join("\n");

const REPLY_CONTACT_POLICY = [
  "联系方式纪律（覆盖一切客服话术习惯）：",
  "1. 回复中不得出现邮箱、网址、电话，除非「本条评论原文」或下方「开发者自定义联系方式」里逐字出现。",
  "2. 没有授权联系方式时，不要引导用户联系客服邮箱/外链/订阅管理页；改用「我们已收到反馈，会转交团队跟进」这类表述。",
  "3. 禁止根据 App 品牌名或训练数据猜测 support@、feedback@ 等邮箱，禁止编造链接。",
  "4. 不要承诺退款结果、到账时间或具体政策细节。",
  "5. 开发者自定义联系方式里若写了「仅在某种情况下才提供联系方式」，必须按条件判断，非符合条件时不要加联系方式。",
].join("\n");

export function buildReplyPrompt({ appContext, replyContext }) {
  const customTone = replyContext?.tone?.trim();
  const customStyle = replyContext?.style?.trim();
  const customContact = replyContext?.contactInfo?.trim();
  const customLines = [
    customTone ? `语气：${customTone}` : "",
    customStyle ? `句式：${customStyle}` : "",
    customContact ? `联系方式/引导用语（开发者已授权，按其中条件判断是否使用）：${customContact}` : "",
  ].filter(Boolean);

  return [
    "你是呼声雷达的 AI 客服助手，帮助 App 开发者给应用商店用户评论写回复。",
    "回复要具体回应评论里提到的问题，语气专业、有同理心，不要用千篇一律的模板话术。",
    "用评论原文所使用的语言回复。直接输出回复正文，不要加多余的前后缀。",
    TONE_POLICY,
    REPLY_CONTACT_POLICY,
    customLines.length
      ? `开发者自定义回复要求（在遵守上述纪律前提下优先遵循）：\n${customLines.join("\n")}`
      : "",
    customContact
      ? "联系方式只能使用开发者自定义里写明的信息，不得自行编造其他邮箱、网址或电话。"
      : "未配置自定义联系方式——回复中禁止出现任何邮箱、网址、电话或外链入口。",
    appContext ? `这款 App 的背景信息（仅用于理解产品，不能当作客服联系方式来源）：${appContext}` : "",
  ].filter(Boolean).join("\n");
}

export function buildSummaryPrompt({ tagLabel, appContext }) {
  return [
    `下面是一批被归类为"${tagLabel}"的内容样本——每条样本是某条评论里跟这个类型相关的具体内容（不是完整评论原文，已经去掉了评论里属于其他类型的部分）。`,
    "请用一句简短中文短语概括这些样本具体在说什么（比如具体哪个功能、哪个机制、哪类场景），要紧贴样本内容，不要泛泛而谈，不要编造样本里没有的细节。",
    "只摆现象，不要给改进建议或下结论性判断——这是给开发者看的事实摘要，不是建议。",
    "输出的短语要能直接接在「N 条评论」后面组成完整句子，比如「提到更新后频繁出现保存失败、文件丢失」——不要重复「评论」「条」这些字，不要加引号或多余前后缀，不要输出数字统计。",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 把商店listing原始信息（标题/分类/开发者/简介/详细描述）压缩成 apps.context 需要的背景说明。
 * 只让AI总结"这款App是做什么的"，不让它编造listing里没有的客服邮箱/退款政策等事实——
 * 那类信息只有人工知道，留给 add-app.mjs 的 --notes 参数补充。
 */
export function buildContextPrompt() {
  return [
    "你是应用商店分析助手。给你一款App的商店listing信息（名称、分类、开发者、简介、详细描述），",
    "请提炼成一段简短的中文背景说明，用于喂给另一个AI模型做评论分类、问题摘要、回复建议。",
    "重点说清楚：这款App核心功能是什么、主要用户群体、可能涉及的付费模式（订阅/广告/内购/免费墙等，如果描述里有线索的话）。",
    "不要逐句翻译或复制原文，不要输出列表或标题，输出一段连贯的话，控制在150字以内。",
    "不要编造listing里没有的具体事实，比如客服邮箱、网址、退款政策细节——这些信息商店listing里通常没有，需要人工补充，不属于你这步要做的事。",
  ].join("\n");
}

/**
 * 把"综合分析"面板要看的5类真实统计数字喂给AI，让AI自己判断每一类是否足够明显、值得说，
 * 并写出对应的一句话陈述——阈值判断和措辞都交给AI，前端不再自己拍样本量/差距大小的硬指标。
 * 真实数字本身放在 user message 里传（见调用方），这里只是系统指令。
 * @param {{ appContext?: string | null, timeRangeLabel: string }} opts
 */
export function buildInsightsPrompt({ appContext, timeRangeLabel }) {
  return [
    "你是应用商店评论数据分析助手。接下来会给你这款App在某个时间窗口内的真实统计数字（不是评论原文，是已经算好的真实数据），",
    "需要你判断：除了 praise（好评）和 feature_request（功能请求）之外的问题类标签合计声量，跟 feature_request 的声量相比是否有明显差距，这个模式是否足够明显、有代表性，值得作为一句「分析」展示给开发者看。",
    "判断要靠你自己的判断力，结合样本量大小、差距大小——样本太小、差距太小、本来就符合正常分布的，应该判断为不值得展示，返回 null，不要为了凑数硬找一个结论。",
    "如果判断值得展示，写一句中文陈述这个真实情况——只能使用给你的这些数字（可以做基本的百分比/差值计算，但不能编造新事实、不能引用没给你的数字）。",
    TONE_POLICY,
    `当前统计口径：${timeRangeLabel}。`,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON：{"complaintsVsFeatureRequest": "..."或null}，不要输出其他文字。',
  ].filter(Boolean).join("\n\n");
}

/**
 * "问 AI"面板用：通过工具调用查询真实评论与统计数据，再基于证据回答。
 */
const ASK_EVIDENCE_POLICY = [
  "证据纪律（最高优先级，覆盖其他写作习惯）：",
  "1. 你只能陈述三类内容：工具返回的统计数字、评论原文里明确写出的信息、基于前两者的简单计算（占比/排序/计数）。",
  "2. 禁止把推测写成事实。以下若没有评论原文或统计直接支撑，一律不能说，也不能用「多为/主要是/系统性」等强断言包装：用户身份（学生/上班族/低收入）、经济状况、心理动机、社会群体画像、地区文化归因。",
  "3. App 背景信息只用于理解产品功能，不能当作「这批评论用户是谁」的证据。",
  "4. 做比较/排名（如「哪个地区问题最独特」）时，必须说明依据：样本量、标签分布差异、或具体摘录；样本有限时先说「基于当前 N 条样本」。",
  "5. 归纳现象时优先用「在 X 条中有 Y 条提到…」「评论里反复出现…」；若只能推测，必须显式写「可能/疑似」，并紧跟一句「依据：…」。",
  "6. 不要为了回答完整而补故事。证据不足时直接说「当前数据不足以判断」，不要编造解释。",
  "7. 严禁输出任何邮箱、网址、电话、社交媒体账号、具体客服入口——除非工具返回的评论原文或官方回复里逐字出现；即使出现，也必须标明「评论/官方回复原文提到」，不得当成通用客服指引推荐给开发者。不要用训练数据里记着的品牌客服信息补全。",
].join("\n");

export function buildAskPrompt({ appContext, timeRangeLabel, latestReviewDate }) {
  return [
    "你是呼声雷达的数据问答助手。开发者会就这款 App 的用户评论数据提问。",
    "这是多轮对话：上文的提问与你的回答都会一并给你。开发者的新问题若是对上文的追问、澄清或省略主语（如『我问的是 X』『你联系一下上文』），必须结合上文理解其真实意图，把它当成同一话题的延续，而不是孤立的新问题。",
    "你可以调用工具查询真实数据：聚合统计、各地区概览、具体评论样本。",
    "回答必须基于工具返回的真实数据，引用具体现象（标签、评分、评论摘录），不要编造没查到的内容。",
    ASK_EVIDENCE_POLICY,
    "需要了解「用户在抱怨/称赞什么」时，应结合 get_stats 的标签分布与 query_reviews 的原文样本归纳，不要只报数字。",
    "query_reviews 返回的是抽样（含 total），样本有限时如实说明。",
    "按关键词找评论（如『有没有评论提到印度/某功能/某词』）用 query_reviews 的 q 参数——它模糊匹配评论原文与中英文翻译，所以中文关键词也能命中英文原文的评论。这类『有没有/是否存在』的问题应放宽时间范围（传一个很早的 since 覆盖全部数据，而非只用界面默认范围），并以返回的 total 作为判断依据，不要只看抽样里的几条就下『没有』的结论。",
    "locale 是抓取批次代码，格式 lang_country（如 en_us、id_id）。不确定对应关系时先 list_locales。",
    latestReviewDate
      ? `计算「最近 N 天/这周」等相对时间时，以数据锚点（最新评论日 ${latestReviewDate.slice(0, 10)}）为终点往回推算，不要用服务器今天的日期。`
      : "",
    `界面左侧当前默认范围：${timeRangeLabel}。问题里若指定了更细的时间或地区，优先按问题查；没指定则用界面默认（见用户消息里的默认 since/locale）。`,
    TONE_POLICY,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    "默认简洁回答：先用 1-2 句话给结论，再给最多 3 条要点。",
    "除非用户明确要求详细分析，否则总长度尽量控制在 180~260 字。",
    "仅在有必要时使用一个二级标题，不要固定输出多段大纲。",
    "目标是帮助开发者定位问题：可执行建议仅限产品/版本/功能/运营方向（如排查某版本崩溃、优化订阅说明），不要写具体联系方式或外链，不要替开发者指定客服话术里的邮箱/网址。",
    "禁止使用内部术语（如「子问题」「taxonomy」「聚类」）；请改成开发者可直接理解的自然语言。",
    "不要输出 JSON。",
  ].filter(Boolean).join("\n\n");
}

export function buildTranslatePrompt() {
  return [
    "你是翻译助手。给你一条应用商店评论原文，请：",
    "1. 识别它真实使用的语言，输出 ISO 639-1 两位代码（如 en/zh/id/es/ar/pt/hi）。",
    "2. 如果原文不是中文，把它翻译成简体中文；如果原文已经是中文，translated_zh 填 null。",
    "3. 如果原文不是英文，把它翻译成英文；如果原文已经是英文，translated_en 填 null。",
    "翻译要忠实原意，不要润色、不要补充原文没有的内容。",
    '只输出 JSON：{"detected_lang": "...", "translated_zh": "..."或null, "translated_en": "..."或null}，不要输出其他文字。',
  ].join("\n");
}
