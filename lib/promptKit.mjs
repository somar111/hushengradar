// Prompt 构建逻辑的唯一来源——lib/classify.ts（Next.js app）和 scripts/cron-fetch.mjs（独立脚本）
// 都从这里导入，避免同一段 prompt 在多个文件里重复维护、改一处漏改另一处。

// 真正跨App通用的三个——"用户满意""用户想要新东西""只是笼统骂没有具体指向"，都是任何产品
// 的评论都可能出现的概念，跟App具体是什么完全无关，所以固定写死，且系统里其他地方（比如
// buildInsightsPrompt 判断"投诉vs功能请求"）依赖这些固定 key 名存在。除此之外的分类（扣费/
// 广告/登录问题之类）是具体产品形态决定的，不该有全局列表，按 app.seed_categories（加App时
// AI根据context提议的起步分类）来定。
// vague_complaint / praise 是 subKey 强制与 Top 反馈 breakdown 的例外——前者说不出具体问题，
// 后者通常不必分子类。其余顶层（含 feature_request 与 App 专属类）终态上应能落到标签体系；
// 若语义上说不清具体点，应归 vague_complaint/praise，而非长期挂在「具体类 + 摘要」上。
// 详见 .cursor/rules/top-feedback-tagging.mdc
export const UNIVERSAL_CATEGORIES = [
  {
    key: "feature_request",
    label: "功能请求",
    intent: "用户希望新增或改进能力/内容/选项（想要、请加、希望有），而非报告现有功能坏了或体验差。",
  },
  {
    key: "praise",
    label: "好评",
    intent: "明确表达满意、喜欢、推荐，没有具体可定位的问题或诉求。",
  },
  {
    key: "vague_complaint",
    label: "意义不明的纯抱怨",
    intent: "只有笼统负面情绪，说不出具体哪里不好；一旦能定位到具体问题则不应使用。",
  },
];

/** App 级可扩展的通用类子问题（如 feature_request 下的「新英雄/新地图」），存在 taxonomy_meta.universal_subcategories */
export const EXTENSIBLE_UNIVERSAL_KEYS = new Set(["feature_request"]);

/** 不要求 subKey、Top 反馈不展示 breakdown 的顶层 key（子问题 count 恒等式也不适用） */
export const NO_SUBTAG_KEYS = new Set(["vague_complaint", "praise"]);

/** 模型分类失败或校验仍不通过时的最大重试次数（不含首次）；配合语义校准与 reclassify，不追求单次定稿 */
export const CLASSIFY_RETRY_ATTEMPTS = 1;

/** 翻译结果缺必需字段时的重试次数（不含首次） */
export const TRANSLATE_RETRY_ATTEMPTS = 1;

/** P1：子 label/evidence 出现这些模式且父类非 feature_request 时，触发语义校准（信号用，非硬路由） */
const REQUEST_LIKE_PATTERN = /请求|希望|想要|请加|添加|增加|缺少|缺失|应该有|need\s|wish|request|add\s|more\s|new\s/i;

/** meta 宽桶 subLabel（应归 general，不应单独建 sub） */
const META_SUB_LABEL_PATTERN = /改进|优化|完善|提升|增强|综合诉求/;

/**
 * 证据主题探测（通用，跨 App）：用于判断评论证据是否更像另一类问题。
 * catalogSignals 用于给 taxonomy 各类打分，patterns 用于匹配单条 evidence。
 */
export const EVIDENCE_THEME_DEFS = [
  {
    id: "matchmaking",
    patterns: /匹配|队友|对手|排位|段位|上分|下分|掉星|人机|\bbot\b|team\s?mate|teammate|carry|单排|组队|连胜|连败|\belo\b|暗系统|dark\s?sist|mvp|kd|人头|付费赢|pay\s?to\s?win|whale/i,
    catalogSignals: /匹配|排位|段位|人机|elo|暗系统|match|rank|queue|team/i,
    exclusionHints: /匹配机制|匹配系统|人机|暗系统|elo|排位/i,
  },
  {
    id: "bugs",
    patterns: /bug|glitch|错误|异常|显示.*(错|异)|消息.*(错|异)|卡住|残留|失灵|不生效|判定错|算给|判负|判胜/i,
    catalogSignals: /bug|错误|闪退|crash|下载|更新|异常|故障/i,
    exclusionHints: /bug|错误|故障|闪退|更新/i,
  },
  {
    id: "network",
    patterns: /延迟|卡顿|lag|ping|掉线|断线|闪退|crash|fps|帧率|发热|nge?lek/i,
    catalogSignals: /网络|性能|延迟|卡顿|连接|帧|发热/i,
    exclusionHints: /网络|性能|延迟|卡顿/i,
  },
  {
    id: "balance",
    patterns: /英雄.*(强|弱|imbalance|buff|nerf)|伤害|血量|hp|控制|眩晕|stun|\bcc\b|翻盘|comeback|平衡|seimbang|equilib|nerf|buff/i,
    catalogSignals: /平衡|强度|控制|数值|伤害|眩晕/i,
    exclusionHints: /平衡|强度|控制|数值/i,
  },
  {
    id: "monetization",
    patterns: /扣费|退款|充值|付费|氪|gacha|抽奖|皮肤.*(贵|骗)|pay|purchase|billing/i,
    catalogSignals: /扣费|付费|充值|退款|billing|purchase|gacha/i,
    exclusionHints: /扣费|付费|充值|退款/i,
  },
];

/** intent「不包括…（归…）」里常见被排除主题 → 证据主题 id */
const EXCLUSION_HINT_TO_THEME = [
  [/匹配机制|匹配系统|人机队友|暗系统|\belo\b/i, "matchmaking"],
  [/功能请求|新增|扩展诉求/i, "feature_request"],
  [/网络|性能|延迟|卡顿/i, "network"],
  [/bug|错误|故障|闪退/i, "bugs"],
  [/扣费|付费|充值|退款/i, "monetization"],
  [/平衡|强度|数值/i, "balance"],
];

/** 子 label 表「难/逆风」但 evidence 表「太简单」等反向语义 */
const SUB_HARD_HINT = /翻盘|comeback|逆风|难|hard|difficult|sulit|challeng|menantang/i;
const EVIDENCE_TOO_EASY = /太简单|过于简单|too easy|terlalu (gampang|mudah)|gampang banget|not challenging|extremamente fácil|terlalu mudah|没有挑战|缺乏挑战|gampang/i;
const SUB_EASY_HINT = /太简单|过于简单|too easy|gampang|mudah/i;
const EVIDENCE_TOO_HARD = /太难|过于难|too hard|terlalu sulit|difficult|menantang|被打哭|tough/i;

function tagEvidenceText(tag) {
  return `${tag.subLabel ?? ""} ${tag.evidence ?? ""} ${tag.subKey ?? ""}`;
}

/** 证据命中哪些主题（按命中 pattern 数降序） */
export function detectEvidenceThemes(text) {
  const scored = [];
  for (const theme of EVIDENCE_THEME_DEFS) {
    const re = theme.patterns;
    if (re.test(text)) scored.push({ id: theme.id, hits: 1 });
  }
  return scored;
}

function scoreCatalogEntryForTheme(entry, themeId) {
  const theme = EVIDENCE_THEME_DEFS.find((t) => t.id === themeId);
  if (!theme || !entry) return 0;
  const blob = `${entry.key} ${entry.label} ${entry.intent ?? ""} ${(entry.subcategories ?? []).map((s) => `${s.key} ${s.label}`).join(" ")}`;
  let score = 0;
  if (theme.catalogSignals.test(blob)) score += 3;
  if (theme.id === "matchmaking" && /match|rank|queue|team/.test(entry.key)) score += 2;
  if (theme.id === "bugs" && /bug|crash|download|update/.test(entry.key)) score += 2;
  if (theme.id === "network" && /network|performance|lag|ping/.test(entry.key)) score += 2;
  if (theme.id === "balance" && /balance|gameplay/.test(entry.key)) score += 2;
  if (theme.id === "monetization" && /billing|purchase|monet|pay/.test(entry.key)) score += 2;
  return score;
}

/** 解析 intent 里「不包括…（归…）」指向的目标顶层 key */
export function resolveIntentExclusionTarget(intent, catalog) {
  if (!intent?.includes("不包括")) return null;
  const routeMatch = intent.match(/归\s*([^）)]+)[）)]/);
  const routeLabel = routeMatch?.[1]?.trim();
  if (!routeLabel) return null;
  const hit = catalog.find(
    (c) => c.label === routeLabel || c.label?.includes(routeLabel) || routeLabel.includes(c.label ?? ""),
  );
  return hit?.key ?? null;
}

/** 证据是否触犯当前类 intent 的「不包括…」 */
export function violatesIntentExclusion(tag, catalog) {
  const entry = catalog.find((c) => c.key === tag.key);
  const intent = entry?.intent ?? "";
  if (!intent.includes("不包括")) return false;
  const text = tagEvidenceText(tag);
  const exclusionPart = intent.match(/不包括([^。；]+)/)?.[1] ?? "";
  for (const [hintRe, themeId] of EXCLUSION_HINT_TO_THEME) {
    if (!hintRe.test(exclusionPart)) continue;
    if (themeId === "feature_request") {
      if (REQUEST_LIKE_PATTERN.test(text)) return true;
      continue;
    }
    if (detectEvidenceThemes(text).some((t) => t.id === themeId)) return true;
  }
  return false;
}

/** 证据主题更像 catalog 里另一个顶层类（比当前类高 ≥2 分） */
export function hasStrongerThemedParent(tag, catalog) {
  if (NO_SUBTAG_KEYS.has(tag.key)) return false;
  const text = tagEvidenceText(tag);
  const themes = detectEvidenceThemes(text);
  if (!themes.length) return false;
  const current = catalog.find((c) => c.key === tag.key);
  const currentScore = Math.max(...themes.map((t) => scoreCatalogEntryForTheme(current, t.id)));
  for (const c of catalog) {
    if (c.key === tag.key || NO_SUBTAG_KEYS.has(c.key)) continue;
    for (const t of themes) {
      const s = scoreCatalogEntryForTheme(c, t.id);
      if (s >= 2 && s >= currentScore + 2) return true;
    }
  }
  return false;
}

/** subLabel/subKey 语义方向与 evidence 明显矛盾 */
export function hasSubLabelPolarityConflict(tag) {
  const text = tagEvidenceText(tag);
  const sub = `${tag.subLabel ?? ""} ${tag.subKey ?? ""}`;
  if (SUB_HARD_HINT.test(sub) && EVIDENCE_TOO_EASY.test(text)) return true;
  if (SUB_EASY_HINT.test(sub) && EVIDENCE_TOO_HARD.test(text)) return true;
  return false;
}

/** taxonomy 修订：不同顶层类下近义/同主题子问题 */
export function findCrossCategorySubOverlaps(seedCategories = []) {
  const overlaps = [];
  const cats = seedCategories ?? [];
  const SHARED_THEME = /暗系统|\belo\b|人机|dark\s?sist/i;
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      const a = cats[i];
      const b = cats[j];
      for (const sa of a.subcategories ?? []) {
        for (const sb of b.subcategories ?? []) {
          if (!sa?.label || !sb?.label) continue;
          const similar = labelsTooSimilar(sa.label, sb.label);
          const sharedTheme = SHARED_THEME.test(sa.label) && SHARED_THEME.test(sb.label);
          if (!similar && !sharedTheme) continue;
          overlaps.push({
            parentA: a.key,
            parentALabel: a.label,
            subA: sa.key,
            subALabel: sa.label,
            parentB: b.key,
            parentBLabel: b.label,
            subB: sb.key,
            subBLabel: sb.label,
            reason: similar ? "近义 sub 跨类" : "同主题跨类重复",
          });
        }
      }
    }
  }
  return overlaps;
}

/** 单条评论分类总则——分类与校准共用 */
export const CLASSIFY_CORE_PRINCIPLE = [
  "分类总则：",
  "1. 看用户真正的抱怨点和诉求——标签应反映用户主要想让产品改什么。",
  "2. 注意区分评论里的原因和后果（原因导致的后果）——找出用户真正的不满对象，按不满对象归类；情绪性后果（如后悔、想离开、想退钱等具体措辞因评论而异）不能替代原因类。",
].join("\n");

/** 非 praise/vague 的「具体类」标签数量 */
export function countSpecificTags(tags) {
  return (tags ?? []).filter((t) => t?.key && !NO_SUBTAG_KEYS.has(t.key)).length;
}

/** 多具体类并存时常伴随原因+后果误标——交给 LLM 原因-后果专检 */
export function needsCauseConsequenceCalibration(tags) {
  return countSpecificTags(tags) >= 2;
}

/** taxonomy 是否已为 App 专属母类写入 intent */
export function hasTaxonomyIntents(seedCategories) {
  return (seedCategories ?? []).some((c) => String(c?.intent ?? "").trim().length > 0);
}

/** 合并通用类 + App taxonomy，供 classify / calibrate 共用 */
export function buildCategoryCatalog(seedCategories = [], universalSubcategories = {}) {
  return [
    ...UNIVERSAL_CATEGORIES.map((c) => ({
      ...c,
      subcategories: universalSubcategories[c.key] ?? c.subcategories ?? [],
    })),
    ...(seedCategories ?? []),
  ];
}

/**
 * P1：结构校验通过后，是否值得做一次语义校准（可疑才调模型，省 API）。
 * @param {ClassifiedTag[]} tags
 * @param {{ seedCategories?: object[], universalSubcategories?: Record<string, {key:string,label:string}[]>, parentKeysWithSubs?: Set<string> }} opts
 */
export function needsSemanticCalibration(tags, { seedCategories = [], universalSubcategories = {}, parentKeysWithSubs } = {}) {
  const catalog = buildCategoryCatalog(seedCategories, universalSubcategories);
  const intentByKey = new Map(catalog.map((c) => [c.key, c.intent ?? ""]));
  const designedSubs = new Map(
    catalog.map((c) => [c.key, new Set((c.subcategories ?? []).map((s) => sanitizeTagKey(s.key)))]),
  );
  const requiresSubs = parentKeysWithSubs ?? new Set();

  for (const t of tags ?? []) {
    if (NO_SUBTAG_KEYS.has(t.key)) continue;

    const text = `${t.subLabel ?? ""} ${t.evidence ?? ""} ${t.subKey ?? ""}`;
    const parentIntent = intentByKey.get(t.key) ?? "";
    const frIntent = intentByKey.get("feature_request") ?? "";
    const designed = designedSubs.get(t.key);

    // 母类须 subKey 但未填 → 结构可疑
    if (requiresSubs.has(t.key) && !t.subKey) return true;

    // 有 ≥2 个设计子类时仍标 general → 可能滥用兜底桶
    if (requiresSubs.has(t.key) && t.subKey === "general" && (designed?.size ?? 0) >= MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN) {
      return true;
    }

    // meta 宽桶 subLabel（××改进/优化）→ 应归 general 或已有具体 sub
    if (t.subKey && t.subKey !== "general" && META_SUB_LABEL_PATTERN.test(String(t.subLabel ?? "").trim())) {
      return true;
    }

    // 投诉类母类下出现明显「想要/请求」表述 → 可能应归 feature_request
    if (t.key !== "feature_request" && parentIntent && frIntent && REQUEST_LIKE_PATTERN.test(text)) {
      if (!parentIntent.includes("希望") && !parentIntent.includes("新增")) return true;
    }

    // 子问题不在 taxonomy 设计清单且非 general → 可能临场造 tag / 归错父类（含 feature_request）
    if (designed?.size && t.subKey && t.subKey !== "general" && !designed.has(t.subKey)) {
      return true;
    }

    // intent「不包括…（归…）」：证据落在被排除主题上 → 须校准 reroute
    if (violatesIntentExclusion(t, catalog)) return true;

    // 证据主题更像其他顶层类（跨类误挂）→ 须校准
    if (hasStrongerThemedParent(t, catalog)) return true;

    // subLabel 语义方向与 evidence 矛盾（如「翻盘难」+「太简单」）→ 须校准
    if (hasSubLabelPolarityConflict(t)) return true;
  }
  return false;
}

export function parseCalibrateTagsFromModel(parsedTags) {
  return parseClassifyTagsFromModel(parsedTags);
}

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


/** 顶层类型是否必须有 subKey（仅当 taxonomy / 复用池里已有子问题清单时） */
export function tagRequiresSubKey(key, parentKeysWithSubs) {
  if (NO_SUBTAG_KEYS.has(key)) return false;
  return Boolean(parentKeysWithSubs?.has(key));
}

/**
 * Top 反馈与子问题强制门槛：须 ≥2 个非 catch-all 子问题才强制 subKey / 展示 chip breakdown。
 * 不足 2 时 UI 走摘要兜底：无筛选读 tag_summaries；有筛选走 summarizeTagsForScope（evidence 仅作样本，禁止直出 UI）。
 * 与 NO_SUBTAG_KEYS 配合：仅 praise、vague_complaint 永远不走 breakdown。
 */
export const MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN = 2;

function isCatchAllSubKey(subKey, label) {
  return subKey === "general" || label === "其他";
}

export function countDesignedMeaningfulSubs(subcategories) {
  return (subcategories ?? []).filter((s) => {
    if (!s?.key) return false;
    return !isCatchAllSubKey(sanitizeTagKey(s.key), s.label);
  }).length;
}

/** taxonomy + 复用池里，哪些顶层类型已有 ≥2 个有效子问题（这些才须填 subKey） */
export function buildParentKeysWithSubs(seedCategories = [], universalSubcategories = {}, existingSubTags = {}) {
  const byParent = new Map();

  for (const [parentKey, subsMap] of subTagsFromSeedCategories(seedCategories)) {
    const set = byParent.get(parentKey) ?? new Set();
    for (const key of subsMap.keys()) {
      if (!isCatchAllSubKey(key)) set.add(key);
    }
    byParent.set(parentKey, set);
  }

  for (const [k, subs] of Object.entries(universalSubcategories ?? {})) {
    const set = byParent.get(k) ?? new Set();
    for (const s of subs ?? []) {
      if (!s?.key) continue;
      const key = sanitizeTagKey(s.key);
      if (!isCatchAllSubKey(key, s.label)) set.add(key);
    }
    byParent.set(k, set);
  }

  for (const [k, subs] of Object.entries(existingSubTags ?? {})) {
    const set = byParent.get(k) ?? new Set();
    for (const s of subs ?? []) {
      if (!s?.key) continue;
      const key = sanitizeTagKey(s.key);
      if (!isCatchAllSubKey(key, s.label)) set.add(key);
    }
    byParent.set(k, set);
  }

  const keys = new Set();
  for (const [parentKey, subs] of byParent) {
    if (subs.size >= MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN) keys.add(parentKey);
  }
  return keys;
}

/** 聚合 subTags 里非 catch-all 子问题的个数 */
export function countMeaningfulSubTags(subTags) {
  return Object.entries(subTags ?? {}).filter(([key, v]) => !isCatchAllSubKey(key, v?.label)).length;
}

/** Top 反馈等聚合展示：须 ≥2 个有效子问题才有 chip breakdown（general/其他 不计入） */
export function hasSubTagBreakdown(subTags) {
  return countMeaningfulSubTags(subTags) >= MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN;
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

function ensureSubTagOnTag(tag, parentKeysWithSubs) {
  if (!tagRequiresSubKey(tag.key, parentKeysWithSubs)) {
    return { ...tag, subKey: null, subLabel: null };
  }
  if (tag.subKey && SUBTAG_REUSE_EXCLUDE_KEYS.has(tag.subKey)) {
    return { ...tag, subLabel: tag.subLabel || "其他" };
  }
  if (tag.subKey) {
    return { ...tag, subLabel: tag.subLabel || tag.subKey };
  }
  return { ...tag, subKey: null, subLabel: null };
}

function fixParentChildNaming(tag, knownTopLevelKeys, parentKeysWithSubs) {
  if (!tagRequiresSubKey(tag.key, parentKeysWithSubs)) {
    return { ...tag, subKey: null, subLabel: null };
  }
  if (!tag.subKey) return tag;
  if (
    tag.subKey === tag.key
    || knownTopLevelKeys.has(tag.subKey)
    || labelsTooSimilar(tag.label, tag.subLabel || tag.subKey)
  ) {
    return { ...tag, subKey: null, subLabel: null };
  }
  return tag;
}

/**
 * 单条评论分类结果的确定性收尾：互斥、撞名修正、子问题兜底、去重。
 * @param {unknown} rawTags 模型 JSON 里的 tags，或已 parse 的数组
 * @param {{ knownTopLevelKeys?: Set<string>, rating?: number, parentKeysWithSubs?: Set<string> }} [opts]
 * @returns {ClassifiedTag[]}
 */
export function finalizeClassifiedTags(rawTags, { knownTopLevelKeys, rating, parentKeysWithSubs } = {}) {
  const known = knownTopLevelKeys ?? new Set();
  const subsKeys = parentKeysWithSubs ?? new Set();
  let tags = Array.isArray(rawTags) && rawTags[0]?.key
    ? rawTags.map((t) => ({ ...t, key: sanitizeTagKey(t.key) }))
    : parseClassifyTagsFromModel(rawTags);

  if (!tags.length) tags = fallbackTagsForRating(rating);

  tags = tags.map((t) => ensureSubTagOnTag(t, subsKeys));
  if (tags.length > 1 && tags.some((t) => t.key === "vague_complaint")) {
    tags = tags.filter((t) => t.key !== "vague_complaint");
  }
  tags = dedupeCrossLevelTags(tags, known);
  tags = tags.map((t) => fixParentChildNaming(t, known, subsKeys));
  tags = tags.map((t) => ensureSubTagOnTag(t, subsKeys));

  const seen = new Set();
  tags = tags.filter((t) => {
    const id = `${t.key}\0${t.subKey ?? ""}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (!tags.length) tags = fallbackTagsForRating(rating);

  return tags;
}

/**
 * 校验单条评论的标签集（确定性规则，不调用模型）。
 * @param {ClassifiedTag[]} tags
 * @param {Set<string>} [knownTopLevelKeys]
 * @param {Set<string>} [parentKeysWithSubs]
 */
export function validateClassifiedTags(tags, knownTopLevelKeys = new Set(), parentKeysWithSubs = new Set()) {
  const errors = [];
  if (!tags.length) errors.push("empty");

  for (const t of tags) {
    if (!t.key || !t.label) errors.push("missing_key_or_label");

    if (tagRequiresSubKey(t.key, parentKeysWithSubs)) {
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
 * 规则 3：有子问题清单的顶层，子问题 count 之和应等于母问题 count。
 * 返回不一致项（多为历史脏数据；新分类经 finalizeClassifiedTags 后应满足）。
 */
export function findTagCountInconsistencies(tagCounts, parentKeysWithSubs = new Set()) {
  const issues = [];
  for (const [key, t] of Object.entries(tagCounts ?? {})) {
    if (!tagRequiresSubKey(key, parentKeysWithSubs)) continue;
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

/** 低命中子问题重分类默认上限（< SUBTAG_REUSE_MIN_COUNT 的不进复用池，cron 可重置重标） */
export const LOW_SUB_RECLASSIFY_MAX_COUNT = SUBTAG_REUSE_MIN_COUNT - 1;

/** taxonomy + universal 里设计的 subKey（按父类），低命中重分类时保留 */
export function buildDesignedSubKeysByParent(seedCategories = [], universalSubcategories = {}) {
  const map = new Map();
  for (const [parentKey, subsMap] of subTagsFromSeedCategories(seedCategories)) {
    map.set(parentKey, new Set(subsMap.keys()));
  }
  for (const [parentKey, subs] of Object.entries(universalSubcategories ?? {})) {
    const set = map.get(parentKey) ?? new Set();
    for (const s of subs ?? []) {
      if (s?.key) set.add(sanitizeTagKey(s.key));
    }
    if (set.size) map.set(parentKey, set);
  }
  return map;
}

/**
 * 找出各父类下命中量 ≤ maxCount、且不在 taxonomy 设计清单里的 subKey（供 reclassify-low-subs / cron）。
 * @returns {Map<string, string[]>} parentKey → subKey[]
 */
export function findLowHitSubKeys(reviews, {
  maxCount = LOW_SUB_RECLASSIFY_MAX_COUNT,
  designedSubKeysByParent = new Map(),
} = {}) {
  const counts = countSubTagsInReviews(reviews);
  const result = new Map();
  for (const [parentKey, byParent] of counts) {
    const designed = designedSubKeysByParent.get(parentKey) ?? new Set();
    const low = [...byParent.entries()]
      .filter(([k, v]) => v.count <= maxCount && !designed.has(k))
      .map(([k]) => k);
    if (low.length) result.set(parentKey, low);
  }
  return result;
}

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
export function buildSubTagReusePool(seedCategories, classifiedReviews, minCount = SUBTAG_REUSE_MIN_COUNT, universalSubcategories = {}) {
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
  return mergeUniversalSubsFromObject(pool, universalSubcategories);
}

function mergeUniversalSubsFromObject(pool, universalSubcategories) {
  const merged = new Map(pool);
  for (const [parentKey, subs] of Object.entries(universalSubcategories ?? {})) {
    if (!Array.isArray(subs) || !subs.length) continue;
    const m = new Map(merged.get(parentKey) ?? []);
    for (const s of subs) {
      if (!s?.key || !s?.label) continue;
      m.set(sanitizeTagKey(s.key), s.label);
    }
    if (m.size) merged.set(parentKey, m);
  }
  return merged;
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
 *   seedCategories?: { key: string, label: string, intent?: string, subcategories?: { key: string, label: string }[] }[],
 *   universalSubcategories?: Record<string, { key: string, label: string }[]>,
 *   existingCustomTags?: { key: string, label: string }[],
 *   existingSubTags?: Record<string, { key: string, label: string }[]>,
 * }} opts
 */
export function buildClassifyPrompt({ appContext, seedCategories = [], universalSubcategories = {}, existingCustomTags = [], existingSubTags = {} }) {
  const catalog = buildCategoryCatalog(seedCategories, universalSubcategories);
  const taxonomyLines = catalog.map((c) => {
    const intentLine = c.intent ? `　意图边界：${c.intent}` : "";
    const subs = Array.isArray(c.subcategories) && c.subcategories.length
      ? `　子问题：${c.subcategories.map((s) => `${s.key}(${s.label})`).join("、")}`
      : (NO_SUBTAG_KEYS.has(c.key) ? "　（此类无子问题）" : "");
    return `- ${c.key}(${c.label})${intentLine}${subs ? "\n" + subs : ""}`;
  });
  const customList = existingCustomTags.length
    ? existingCustomTags.map((c) => `${c.key}(${c.label})`).join("、")
    : null;
  const subTagLines = Object.entries(existingSubTags)
    .filter(([, subs]) => subs.length)
    .map(([parentKey, subs]) => `  - ${parentKey} 下已有：${subs.map((s) => `${s.key}(${s.label})`).join("、")}`);

  return [
    "你是应用商店评论分析助手。下面是这款 App 已经设计好的「问题分类体系」（顶层类型 + 各自的意图边界 + 子问题）。你的任务是把给你的这条评论对应到这套体系上。",
    CLASSIFY_CORE_PRINCIPLE,
    "分类体系：\n" + taxonomyLines.join("\n"),
    "跨类边界（最高优先级之一）：",
    COMPLAINT_VS_REQUEST_BOUNDARY,
    "各顶层类型的 intent 若含「不包括…（归…）」，分类时必须遵守——证据落在被排除主题上时，应归 intent 指定的目标类，不要因 subLabel 沾边就塞进当前类。",
    customList
      ? `这款 App 之前还临时扩展过这些顶层类型，如果评论符合，优先复用，不要再造近义的新 key：${customList}。`
      : "",
    "用体系里已有的类型时把握一个平衡：一方面，不要造近义的新顶层类型——如果评论说的是某个已有类型的同一个底层问题、只是换了说法或情绪（比如体系里已有「未经授权扣费」，就不要再为「被骗钱/诈骗扣费」单开新类型），归到已有的那个。另一方面，也不要为了复用就硬塞——如果评论说的问题跟所有已有类型性质都明显不同（比如「偷偷安装别的软件/索要过多权限/隐私担忧」跟「崩溃」「广告」都不是一回事），硬塞会让分类明显错误，这时就应该创建一个准确的新顶层类型（英文 snake_case + 中文 label），而不是塞进不沾边的类型。判断标准：宁可新建一个准确的类型，也不要塞进一个明显不对的类型。",
    "一条评论可以命中多个类型，但每条至少命中一个。",
    "关于 vague_complaint(意义不明的纯抱怨)：只有当整条评论确实没有任何具体可定位的问题时才用它——比如只说「垃圾」「难用」「Desagradable」「一星」这种纯情绪、说不出哪里不好。注意：「广告太多」「字体太小」「要付费才能用」「导出很麻烦」「偷偷装别的软件」「老让我登录」这些都是具体问题，必须归到对应的具体类型，绝不能进 vague_complaint。vague_complaint 是互斥的：只要有任何一个具体类型命中，就不要再加 vague_complaint；用了 vague_complaint 它就必须是唯一的标签。",
    "评论常一次说好几件不相关的事——每个命中的类型都要单独给一句 evidence：只转述这条评论里跟这个类型相关的那部分内容（简短中文），不要把属于别的类型的内容混进来。",
    "子问题：仅当该顶层类型在 taxonomy 中有子问题清单时，才须指定 subKey/subLabel；没有子问题清单的类型，subKey/subLabel 留 null。vague_complaint 和 praise 始终留 null。",
    "子问题纪律：① 有子问题清单时，须优先从清单或下方「已确认子问题」里复用已有 subKey/subLabel。② 禁止为同一概念造近义 subKey。③ 现有子问题都无法覆盖、且该诉求不像会反复出现的稳定主题时，必须使用 subKey=general、subLabel=其他，禁止为单条或极少数评论新建 subKey。④ 禁止创建「××改进」「××优化」「综合诉求」等 meta 宽桶 sub，这类一律用 general(其他)。⑤ 只有预期会稳定复现的新主题才新建 subKey（英文 snake_case + 中文 label）。",
    "subKey 不能与任何顶层类型的 key 相同，子问题的 label 也不能与母类型的 label 相同或过于近似（否则应归并为同一类型，而不是母子重复）。如果某个子问题其实本身就是一个顶层类型，就直接命中那个顶层类型，别塞进别的类型下面当子问题。",
    subTagLines.length
      ? `以下子问题已在 taxonomy 或历史评论中稳定出现，符合就必须优先复用（禁止造近义新 subKey）：\n${subTagLines.join("\n")}`
      : "",
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON，格式：{"tags": [{"key": "...", "label": "...", "evidence": "...", "subKey": "..."或null, "subLabel": "..."或null}]}，不要输出任何其他文字。',
  ].filter(Boolean).join("\n");
}

/**
 * P1：单条语义校准——在结构校验通过后，判断标签是否归错母类/子类。
 * @param {Parameters<typeof buildClassifyPrompt>[0]} opts
 */
export function buildCalibratePrompt(opts) {
  const classifyBlock = buildClassifyPrompt(opts);
  return [
    "你是评论分类「校准员」。已有一条评论的初步分类结果，你的任务是判断这些标签的语义是否与评论意图一致，尤其是跨类边界。",
    classifyBlock,
    "校准纪律：",
    "1. 若初步分类符合分类总则（真正的抱怨点/诉求、原因与后果区分正确）且与各类 intent 边界一致，verdict 填 ok，原样返回 tags。",
    "2. 若明显归错类——包括按后果而非原因归类、功能诉求被塞进抱怨类、或抱怨被标成 feature_request——verdict 填 reroute，给出修正后的完整 tags 数组。",
    "3. reroute 时仍须遵守分类体系：优先复用已有 subKey；feature_request 与 praise/vague_complaint 的 subKey 规则不变。",
    "4. 不要过度纠正——边界模糊时保留原分类，verdict 填 ok。",
    "5. 若 subKey 不在 taxonomy 清单、或 label 属于 meta 宽桶（改进/优化/综合诉求），优先 reroute：现有具体 sub 能覆盖 → 改到已有 sub；无法覆盖且为低频杂项 → 改 subKey=general、subLabel=其他，删除临时 subKey。",
    "6. 严格遵守各类 intent 中的「不包括…（归…）」：若 evidence 落在被排除主题（如匹配/人机/暗系统/ELO、bug、网络卡顿、扣费），必须 reroute 到 intent 指定的目标顶层类及其 subKey，即使当前 subLabel 看起来相关。",
    "7. 若 subLabel 语义方向与 evidence 矛盾（如 sub 表「翻盘难/太难」但 evidence 表「太简单/无挑战」），必须 reroute 到更合适的 sub 或 general(其他)。",
    "8. bug/显示错误/判定错误类 evidence 不要标进平衡/匹配类；优先找 taxonomy 中负责 bug/网络/性能的类。",
    '只输出 JSON：{"verdict":"ok"或"reroute","reason":"简短中文","tags":[...]}，不要输出其他文字。',
  ].join("\n\n");
}

/**
 * P1b：原因-后果专检——仅在多具体类并存时追加一次 LLM 调用，判断由模型做语义区分（无领域关键词表）。
 * @param {Parameters<typeof buildClassifyPrompt>[0]} opts
 */
export function buildCauseConsequenceCalibratePrompt(opts) {
  const classifyBlock = buildClassifyPrompt(opts);
  return [
    "你是评论分类的「原因-后果」校准员。初步分类已给出多个具体类标签，你的唯一任务是按语义修剪误标。",
    CLASSIFY_CORE_PRINCIPLE,
    classifyBlock,
    "专检纪律（全部由你按评论语义判断，勿靠关键词表）：",
    "1. 原因 vs 后果：若某 tag 的 evidence 只是其它已标问题的情绪/行为后果（如后悔、泄愤、想离开、想退钱等——以评论实际表述为准），而同时存在指向具体不满对象的 tag，删除后果类 tag。",
    "2. subLabel 语义本体：每个 subLabel 描述一类具体障碍/缺陷/对象；evidence 须说明该类障碍或对象，不能仅为愿望、情绪或与 subLabel 无关的换词。",
    "3. 若删除后果 tag 后仍有明确原因 tag，保留原因 tag；若整句只有笼统情绪且说不出具体点，可收敛为 vague_complaint。",
    "4. 不要过度删除——边界模糊时 verdict 填 ok。",
    '只输出 JSON：{"verdict":"ok"或"reroute","reason":"简短中文","tags":[...]}，不要输出其他文字。',
  ].join("\n\n");
}

/** 子问题设计纪律——bootstrap / feature_request 归纳 / taxonomy 修订 共用 */
export const SUBCATEGORY_DESIGN_POLICY = [
  "子问题设计纪律（所有归纳 subcategories 时必须遵守）：",
  "1. 读者测试：label 必须让没玩过这类产品的人也能懂——用户具体要什么对象/能力，或现有哪方面出了问题。",
  "2. 禁黑话直译：不要把英文缩写、圈内术语字面翻成中文（由你判断何为黑话）；用普通用户会说的中文。",
  "3. 禁 meta 宽桶：不允许「××改进」「××优化」「综合诉求」「其他功能」等没有具体对象的 sub；杂项只能留给系统统一的 general(其他)，且分类时不应滥用。",
  "4. 互斥：sibling subs 按「诉求/问题对象或场景」划分，不按笼统「体验」或情绪划分；两个 sub 不能覆盖同一类评论。",
  "5. 可分类测试：每个 sub 用一句话定义范围；给定两条典型评论，必须能明确只属于其中一个 sub。",
  "6. 跨 catalog 不重复：若 App 专属投诉类已有某主题子问题（如「语言选项不足」），feature_request 侧应用不同措辞表达「新增某语言」等诉求侧含义，避免同名同义。",
  "7. 跨顶层不重复：同一底层主题（如暗系统/ELO、人机队友、bug）只能在一个顶层类下出现；若两个顶层类的 sub 近义或同主题，修订时必须合并到 intent 更匹配的那一类并 remap/reclassify。",
  `8. 展示门槛：App 专属顶层类须 ≥${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN} 个有效子问题（不含 general/其他），分类才强制 subKey、Top 反馈才出 chip；新固化孤儿类不得只给 1 个 sub。`,
].join("\n");

/** 投诉类 vs feature_request 边界——intent 补全 / 分类 / 校准 共用 */
export const COMPLAINT_VS_REQUEST_BOUNDARY = [
  "与 feature_request(功能请求) 的边界：",
  "- feature_request：用户明确想要新增/扩展能力或内容（想要、请加、希望有、need more）。这是诉求，不是报现有功能坏了。",
  "- 各 App 专属「投诉/抱怨」类（如内容与功能、网络与性能）：只描述现有功能/内容的缺陷、体验差、不合理——不是单纯想要新东西。",
  "- 同一主题可两端并存（如「语言选项太少」是抱怨现状、「请加阿拉伯语」是诉求），但分类时：纯诉求必须单独命中 feature_request，不要塞进抱怨类的 subKey；可双标，不可把诉求只标在抱怨类下。",
  "- 投诉类 intent 必须写清：「不管纯新增/扩展诉求；即使主题相关也归 feature_request」。",
].join("\n");

/**
 * P0.5：taxonomy / 子问题设计产出后的校准 prompt（写库前必过）。
 * @param {{ mode?: 'full_taxonomy'|'subcategories', parentKey?: string, parentLabel?: string }} opts
 */
export function buildTaxonomyDesignCalibratePrompt({ mode = "subcategories", parentKey, parentLabel } = {}) {
  const scope =
    mode === "full_taxonomy"
      ? "完整 taxonomy（顶层类型 + 各自子问题）"
      : parentKey
        ? `${parentKey}(${parentLabel ?? parentKey}) 下的子问题清单`
        : "feature_request 的 App 级扩展子问题清单";
  return [
    "你是分类体系的「设计校准员」。刚有一份 AI 归纳的分类/子问题草稿，写进权威 taxonomy 之前，你必须检查并修正设计质量问题。",
    `检查对象：${scope}。`,
    SUBCATEGORY_DESIGN_POLICY,
    COMPLAINT_VS_REQUEST_BOUNDARY,
    "校准任务：",
    "1. 删掉、拆分或改名过宽、黑话直译、无具体对象的 sub。",
    "2. 合并语义重叠的 sibling subs。",
    "3. 确保每个 sub 指向具体对象/场景，不是笼统「改进/优化」。",
    "4. 若草稿已合格，verdict 填 ok，原样返回；否则 verdict 填 revise，输出修订后的完整列表（不是增量 patch）。",
    mode === "full_taxonomy"
      ? '只输出 JSON：{"verdict":"ok"或"revise","reason":"简短中文","categories":[{"key":"...","label":"...","intent":"...","subcategories":[{"key":"...","label":"..."}]}]}'
      : '只输出 JSON：{"verdict":"ok"或"revise","reason":"简短中文","subcategories":[{"key":"...","label":"..."}]}',
    "不要输出其他文字。",
  ].join("\n");
}

/**
 * 为已有 taxonomy 补 intent（不写库，由调用方写回）。用于旧 App 升级 P0。
 */
export function buildEnrichIntentsPrompt() {
  return [
    "你是分类体系维护者。给你一款 App 的背景和当前 taxonomy（顶层+子问题，可能缺 intent），请为每个 App 专属顶层类型补一句「意图边界」intent。",
    "intent 要说清：这类标签管什么、不管什么；尤其与 feature_request（功能请求）、vague_complaint 的边界。",
    COMPLAINT_VS_REQUEST_BOUNDARY,
    "不要改 key/label/subcategories，只补 intent 字段。不要包含 praise/feature_request/vague_complaint。",
    '只输出 JSON：{"categories":[{"key":"...","label":"...","intent":"...","subcategories":[...]}]}，结构与输入一致。',
  ].join("\n");
}

/**
 * 为任意 App 专属顶层类归纳子问题（revision 补足 sub、与 feature_request 归纳同管线）。
 */
export function buildParentSubsPrompt({ parentLabel, intent }) {
  return [
    `你是评论分析专家。根据 App 背景和一批已归入「${parentLabel}」的评论样本，归纳 ${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN}~6 个可复用的子问题（英文 snake_case key + 中文 label）。`,
    intent ? `该顶层类的 intent 边界：${intent}` : "",
    "子问题必须互斥，覆盖样本里反复出现的不同主题；不要把报 bug、功能请求、纯情绪抱怨混进来。",
    SUBCATEGORY_DESIGN_POLICY,
    COMPLAINT_VS_REQUEST_BOUNDARY,
    `必须至少输出 ${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN} 个有效子问题（不含 general/其他）。`,
    '只输出 JSON：{"subcategories":[{"key":"...","label":"..."}]}',
  ].filter(Boolean).join("\n");
}

/**
 * 为 feature_request 设计 App 级子问题清单（通用类在各 App 的扩展）。
 */
export function buildFeatureRequestSubsPrompt() {
  return [
    "你是评论分析专家。根据 App 背景和一批被标为「功能请求」的评论样本，归纳 3~8 个可复用的 feature_request 子问题（英文 snake_case key + 中文 label）。",
    "只归纳「想要新增/扩展」类诉求，不要把报 bug、体验差、退款等抱怨塞进来。",
    SUBCATEGORY_DESIGN_POLICY,
    COMPLAINT_VS_REQUEST_BOUNDARY,
    "每个 sub 应表达用户想要的新增对象（如「新增某语言」「新增某角色/皮肤」），不要用笼统「改进/优化」类 label。",
    '只输出 JSON：{"subcategories":[{"key":"...","label":"..."}]}',
  ].join("\n");
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
    "5. 每个顶层类型必须给一句 intent（意图边界）：说清这类管什么、不管什么；与 feature_request（用户想要新东西）和 vague_complaint 的边界要写清楚。",
    "6. 关键之三——不重叠：同一个具体问题只能属于一个顶层类型，同一个（或近义的）子问题不能在多个顶层类型下重复出现。如果一个问题横跨多个类型（比如「取消订阅后还在扣费」既沾「扣费」又沾「取消」），只放到最贴近用户核心痛点的那一个类型下，另一个类型不要再列。顶层类型之间、子问题之间都要互斥、不交叉。",
    "7. 不要包含「好评」「功能请求」「意义不明的纯抱怨」这三类——它们是系统通用类别，已固定存在，你不用管。",
    "8. key 用英文 snake_case（全小写、下划线分隔），label 用简短中文。",
    SUBCATEGORY_DESIGN_POLICY,
    COMPLAINT_VS_REQUEST_BOUNDARY,
    '只输出 JSON：{"categories": [{"key": "...", "label": "...", "intent": "...", "subcategories": [{"key": "...", "label": "..."}]}]}，不要输出其他文字。',
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
    SUBCATEGORY_DESIGN_POLICY,
    COMPLAINT_VS_REQUEST_BOUNDARY,
    "应当修订的典型信号：① 同一底层问题被拆成多个近义子问题（该合并）；② 大量、且跨时间持续地落在「孤儿顶层标签」或 vague_complaint，说明体系缺了某个真实类目（该新增/拆分）；③ 某子问题已稳定大量、跨时间出现却还没进体系（该固化）；④ 某 label 措辞不准或与母类重名（该改名）；⑤ **跨类 misroute**：某 App 专属母类下稳定出现语义属于 feature_request 的子问题——应 remap 到正确顶层，或触发 reclassify；⑥ **过宽 sub**：某 sub 占父类命中量过高且 evidence 跨多个不相关主题——应拆分或改名。",
    "每条变更必须标注「落地代价」consequence，二选一：",
    "  - \"remap\"：改名(rename_label)、合并近义子问题(merge_subcategories)、固化已稳定出现的子问题(promote_subcategory)——这些能用确定性映射直接改写已有标签，不需要重读评论。这时必须在 remap 数组里给出映射：每项 {\"match\":{\"key\":\"...\",\"subKey\":\"...\"或null},\"set\":{可选 key/label/subKey/subLabel}}，表示把命中 match 的已有标签字段改成 set。",
    "  - \"reclassify\"：新增顶层类目(add_category)、拆分类目(split_category)、删除/合并顶层类目(merge_categories/drop_category)等——这些要重读评论才能正确归类。这时给出 affectedKeys：哪些现有顶层 key（含 vague_complaint）下的评论需要被重读。不要给 remap。",
    `add_category 纪律：① 新固化的孤儿顶层类必须带 ≥${MIN_MEANINGFUL_SUBTAGS_FOR_BREAKDOWN} 个互斥子问题（不含 general/其他）；② affectedKeys 必须包含该新顶层 key 本身——已有此 tag 的评论须重填 subKey。`,
    "母类从不足 2 个有效 sub 增至 ≥2 个时，affectedKeys 须包含该母类 key，以便已有命中重填 subKey。",
    "判断 remap 还是 reclassify 的准绳：如果旧标签能被一条确定规则唯一映射到新标签，就是 remap；只要需要『看评论内容才能决定归到哪』，就是 reclassify。拿不准时选 reclassify，宁可走人工确认也不要错改数据。",
    "taxonomy 字段必须是修订后的**完整**体系（不是增量），沿用与输入相同的结构：[{\"key\",\"label\",\"intent\",\"subcategories\":[{\"key\",\"label\"}]}]；key 用英文 snake_case，label 用简短中文；顶层类型之间、子问题之间互斥不重叠；不要包含 praise/feature_request/vague_complaint 这三个系统通用类。",
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

export function buildReplyPrompt({ appContext, replyContext, displayName, terminologyGlossary }) {
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
    "整条回复自始至终只用一种语言——评论原文所用的那种语言。绝对不要夹杂别的语言的词（尤其不要把中文词混进外语句子里，比如在葡语/英语句子中突然出现中文）。",
    TONE_POLICY,
    REPLY_CONTACT_POLICY,
    formatTerminologyGlossaryBlock(terminologyGlossary, { displayName }),
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

function buildAskFormatPolicy(useEmoji) {
  const emojiRule = useEmoji
    ? "开发者已在界面开启「Emoji」：汇总/分类类回答中，每个大类标题前必须加 1 个贴合语义的 emoji；`##` 总标题也可加 1 个。子项内不要堆砌 emoji。"
    : "开发者已在界面关闭「Emoji」：全文禁止使用任何 emoji 或表情符号。";
  return [
    "可读性（在遵守证据纪律前提下）：",
    "1. 简单问答：1~2 句结论 + 最多 3 条要点。",
    "2. 汇总/排名/分类对比类问题：用 Markdown 结构呈现——`##` 总标题；每个大类占有序列表一项，类名用 **加粗**；具体子项用嵌套无序列表（`-`）缩进在其下；关键数字加粗。大类之间自然分段，便于扫读。",
    emojiRule,
    "3. 用户要详细分析时，可突破默认字数上限，优先保证结构清楚、数字准确，不要为了短而省略分类层级。",
    "4. 需要表格对比（如地区×指标、多列分类）时用 GFM 表格；补充说明用 `>` 引用块。",
  ].join("\n");
}

export function buildAskPrompt({ appContext, timeRangeLabel, latestReviewDate, useEmoji = false, displayName, terminologyGlossary }) {
  return [
    "你是呼声雷达的数据问答助手。开发者会就这款 App 的用户评论数据提问。",
    "这是多轮对话：上文的提问与你的回答都会一并给你。开发者的新问题若是对上文的追问、澄清或省略主语（如『我问的是 X』『你联系一下上文』），必须结合上文理解其真实意图，把它当成同一话题的延续，而不是孤立的新问题。",
    "你可以调用工具查询真实数据：聚合统计、各地区概览、评论条数计数、具体评论样本。",
    "回答必须基于工具返回的真实数据，引用具体现象（标签、评分、评论摘录），不要编造没查到的内容。",
    ASK_EVIDENCE_POLICY,
    "问「某顶层标签/子标签有多少条评论」时：必须先调 count_reviews（tag + 必要时 subTag），以返回的 total 为唯一条数口径——与 Demo 评论查看&回复列表一致。不要用 get_stats 的 subTagBreakdown.count 代替（那是标签命中次数，且与列表筛选不完全同义）。UI 子标签「其他」对应 subTag=general；先用 get_stats 查 key/subKey 名称，再用 count_reviews 计数。",
    "需要了解「用户在抱怨/称赞什么」时，应结合 get_stats 的分布与 query_reviews 的原文样本归纳；count_reviews 只用于精确条数。",
    "query_reviews 返回的是抽样（含 total），样本有限时如实说明。",
    "按关键词找评论（如『有没有评论提到印度/某功能/某词』）用 query_reviews 的 q 参数——它模糊匹配评论原文与中英文翻译，所以中文关键词也能命中英文原文的评论。这类『有没有/是否存在』的问题应放宽时间范围（传一个很早的 since 覆盖全部数据，而非只用界面默认范围），并以返回的 total 作为判断依据，不要只看抽样里的几条就下『没有』的结论。",
    "locale 是抓取批次代码，格式 lang_country（如 en_us、id_id）。不确定对应关系时先 list_locales。",
    latestReviewDate
      ? `计算「最近 N 天/这周」等相对时间时，以数据锚点（最新评论日 ${latestReviewDate.slice(0, 10)}）为终点往回推算，不要用服务器今天的日期。`
      : "",
    `界面左侧当前默认范围：${timeRangeLabel}。问题里若指定了更细的时间或地区，优先按问题查；没指定则用界面默认（见用户消息里的默认 since/locale）。`,
    TONE_POLICY,
    formatTerminologyGlossaryBlock(terminologyGlossary, { displayName }),
    buildAskFormatPolicy(Boolean(useEmoji)),
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    "默认简洁回答：先用 1-2 句话给结论，再给最多 3 条要点。",
    "除非用户明确要求详细分析或汇总分类，否则总长度尽量控制在 180~260 字。",
    "仅在有必要时使用一个二级标题，不要固定输出多段大纲。",
    "目标是帮助开发者定位问题：可执行建议仅限产品/版本/功能/运营方向（如排查某版本崩溃、优化订阅说明），不要写具体联系方式或外链，不要替开发者指定客服话术里的邮箱/网址。",
    "禁止使用内部术语（如「子问题」「taxonomy」「聚类」）；请改成开发者可直接理解的自然语言。",
    "不要输出 JSON。",
  ].filter(Boolean).join("\n\n");
}

export function buildTranslatePrompt({ appContext, displayName, terminologyGlossary } = {}) {
  const glossaryBlock = formatTerminologyGlossaryBlock(terminologyGlossary, { displayName });
  return [
    "你是翻译助手。给你一条应用商店评论原文，请：",
    "1. 识别它真实使用的语言，输出 ISO 639-1 两位代码（如 en/zh/id/es/ar/pt/hi）。",
    "2. 如果原文不是中文，把它翻译成简体中文；如果原文已经是中文，translated_zh 填 null。",
    "3. 如果原文不是英文，把它翻译成英文；如果原文已经是英文，translated_en 填 null。",
    "4. 纪律：非中文原文必须给出 translated_zh；非英文原文必须给出 translated_en。缺任一必需译文视为无效输出。",
    "翻译要忠实原意，不要润色、不要补充原文没有的内容。",
    glossaryBlock,
    appContext ? `这款 App 的背景信息：${appContext}` : "",
    '只输出 JSON：{"detected_lang": "...", "translated_zh": "..."或null, "translated_en": "..."或null}，不要输出其他文字。',
  ].filter(Boolean).join("\n");
}

/** 规范化模型返回的翻译 JSON */
export function normalizeTranslateResult(raw) {
  const lang = String(raw?.detected_lang ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 2);
  const zh = String(raw?.translated_zh ?? "").trim();
  const en = String(raw?.translated_en ?? "").trim();
  return {
    detected_lang: lang || null,
    translated_zh: zh || null,
    translated_en: en || null,
  };
}

/**
 * 按 buildTranslatePrompt 规则：非 zh 必须有 translated_zh，非 en 必须有 translated_en。
 * @param {{ detected_lang?: string|null, translated_zh?: string|null, translated_en?: string|null }} result
 */
export function isTranslateResultComplete(result) {
  const lang = String(result?.detected_lang ?? "")
    .trim()
    .toLowerCase();
  if (!lang) return false;
  if (lang !== "zh" && !String(result?.translated_zh ?? "").trim()) return false;
  if (lang !== "en" && !String(result?.translated_en ?? "").trim()) return false;
  return true;
}

/**
 * 库内评论是否仍需（或重新）翻译。
 * @param {{ content?: string|null, translated_at?: string|null, detected_lang?: string|null, translated_zh?: string|null, translated_en?: string|null }} review
 */
export function reviewNeedsTranslation(review) {
  if (!String(review?.content ?? "").trim()) return false;
  if (!review.translated_at) return true;
  return !isTranslateResultComplete(review);
}

/** 清洗 App 术语表（写库 / 注入 prompt 前） */
export function sanitizeTerminologyGlossary(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const e of raw) {
    const source = String(e?.source ?? "").trim();
    if (!source || seen.has(source.toLowerCase())) continue;
    seen.add(source.toLowerCase());
    out.push({
      source,
      zh: String(e?.zh ?? "").trim() || null,
      en: String(e?.en ?? "").trim() || null,
      note: String(e?.note ?? "").trim() || null,
    });
  }
  return out.slice(0, 200);
}

/** 格式化为 prompt 段落；glossary 为空时仍注入「未知专名不意译」纪律 */
export function formatTerminologyGlossaryBlock(glossary, { displayName } = {}) {
  const entries = sanitizeTerminologyGlossary(glossary);
  const lines = [
    "产品专名与术语纪律：",
    displayName ? `当前产品：${displayName}` : "",
    "未知专名（术语表未收录的人名、皮肤 codename、活动名等）保留原文，禁止按字面意译。",
  ].filter(Boolean);
  if (entries.length) {
    lines.push("以下术语必须按表使用（翻译/回复/分析时一致）：");
    for (const e of entries) {
      const parts = [e.source];
      if (e.zh) parts.push(`中文→${e.zh}`);
      if (e.en) parts.push(`英文→${e.en}`);
      lines.push(`- ${parts.join("；")}${e.note ? `（${e.note}）` : ""}`);
    }
  } else {
    lines.push("（术语表暂无条目——仍须遵守「未知专名保留原文、禁止意译」规则。）");
  }
  return lines.join("\n");
}
