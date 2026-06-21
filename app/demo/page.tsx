"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Layers, Languages,
  TrendingDown, GitCompare, ListTodo, Reply,
  Send, X, BarChart2, PanelLeft, Search, Loader2, Settings,
} from "lucide-react";
import { type ReviewRow, type AppRow } from "@/lib/supabase";

// ─── 类型 ────────────────────────────────────────────────────

// locale 只是"用哪组 lang/country 参数抓到这条"，不代表真实评论语言，纯展示用
//
// 短称覆盖表：只收录想要更口语化短名的地区（"印尼"比"印度尼西亚"顺口，"沙特"比"沙特阿拉伯"顺口）。
// 没收录的地区会自动 fallback 到 Intl.DisplayNames 生成，所以这张表是锦上添花的可选项，
// 不是必需维护项——以后 apps.target_locales 里加任何新地区，名字都不会退化成裸 code。
const localeLabelOverrides: Record<string, string> = {
  en_us: "英语 · 美国",
  id_id: "印尼语 · 印尼",
  es_mx: "西班牙语 · 墨西哥",
  ar_sa: "阿拉伯语 · 沙特",
  pt_br: "葡萄牙语 · 巴西",
  hi_in: "印地语 · 印度",
  fr_fr: "法语 · 法国",
  de_de: "德语 · 德国",
  ru_ru: "俄语 · 俄罗斯",
  vi_vn: "越南语 · 越南",
  th_th: "泰语 · 泰国",
  tr_tr: "土耳其语 · 土耳其",
  ja_jp: "日语 · 日本",
  ko_kr: "韩语 · 韩国",
};

let languageNames: Intl.DisplayNames | null = null;
let regionNames: Intl.DisplayNames | null = null;
try {
  languageNames = new Intl.DisplayNames(["zh"], { type: "language" });
  regionNames = new Intl.DisplayNames(["zh"], { type: "region" });
} catch {
  // 老浏览器没有 Intl.DisplayNames，fallback 失效时退化成裸 code，不影响功能
}

type Stats = {
  total: number;
  dateRange: { from: string | null; to: string | null };
  ratingDist: Record<string, number>;
  tagCounts: Record<string, { label: string; count: number; summary: string | null }>;
  localeCounts: Record<string, number>;
  versionStats: { version: string; count: number; avgRating: number }[];
  officialReplyRate: number;
};

type RightPanel = "complaints" | "comparison" | "demands" | "reply";
type MobileTab = "filter" | "analyze";
type Platform = "googleplay" | "appstore";
type TargetLang = "zh" | "en";
type TranslateScope = "non_target" | "non_zh_en";
type TimeRange = "week" | "month";

type TranslateSettings = {
  enabled: boolean;
  targetLang: TargetLang;
  scope: TranslateScope;
};

const PAGE_SIZE = 200;

function getDisplayContent(r: ReviewRow, s: TranslateSettings): { text: string; translated: boolean } {
  if (!s.enabled) return { text: r.content, translated: false };
  const lang = r.detected_lang;
  if (s.scope === "non_zh_en" && (lang === "zh" || lang === "en")) {
    return { text: r.content, translated: false };
  }
  if (s.targetLang === "zh") {
    if (lang === "zh" || !r.translated_zh) return { text: r.content, translated: false };
    return { text: r.translated_zh, translated: true };
  }
  if (lang === "en" || !r.translated_en) return { text: r.content, translated: false };
  return { text: r.translated_en, translated: true };
}

// ─── 子组件 ──────────────────────────────────────────────────

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-yellow-400 text-[14px] tracking-tight">
      {"★".repeat(rating)}{"☆".repeat(5 - rating)}
    </span>
  );
}

function GlassPanel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#181a1f] ${className}`}>{children}</div>;
}

function DonutPercent({ percent, size = 40, color = "#8b5cf6" }: { percent: number; size?: number; color?: string }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.min(percent, 100) / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-none">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#ffffff14" strokeWidth={3} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={3}
        strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill="#fff" fontSize={size * 0.26} fontWeight={600}>
        {Math.round(percent)}%
      </text>
    </svg>
  );
}

function fmtDate(iso: string | null) {
  return iso ? iso.slice(0, 10) : "—";
}

function localeLabel(locale: string | null) {
  if (!locale) return "未知";
  if (localeLabelOverrides[locale]) return localeLabelOverrides[locale];
  const [lang, country] = locale.split("_");
  if (languageNames && regionNames && lang && country) {
    try {
      return `${languageNames.of(lang)} · ${regionNames.of(country.toUpperCase())}`;
    } catch {
      // code 不被识别（比如自定义/小众组合），退化成裸 code
    }
  }
  return locale;
}

// ─── 主组件 ─────────────────────────────────────────────────

export default function DemoPage() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<RightPanel>("complaints");
  const [platform, setPlatform] = useState<Platform>("googleplay");
  const [apps, setApps] = useState<AppRow[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string | undefined>(undefined);
  const [timeRange, setTimeRange] = useState<TimeRange>("week");
  const [locale, setLocale] = useState<string | undefined>(undefined);
  const [tagFilter, setTagFilter] = useState<string | undefined>(undefined);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [mobileTab, setMobileTab] = useState<MobileTab>("analyze");
  const [translateSettings, setTranslateSettings] = useState<TranslateSettings>({
    enabled: true,
    targetLang: "zh",
    scope: "non_target",
  });
  const [showTranslateSettings, setShowTranslateSettings] = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const [selectedReview, setSelectedReview] = useState<ReviewRow | null>(null);
  const [aiReply, setAiReply] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{ q: string; a: string }[]>([]);

  const isReplyMode = activePanel === "reply";

  const since = useMemo(() => {
    const days = timeRange === "week" ? 7 : 30;
    return new Date(Date.now() - days * 86400000).toISOString();
  }, [timeRange]);
  const timeRangeLabel = timeRange === "week" ? "最近一周" : "最近一月";
  const selectedApp = apps.find((a) => a.id === selectedAppId);
  const appName = selectedApp?.display_name ?? "App";

  // 拉 App 列表，默认选第一个
  useEffect(() => {
    fetch("/api/demo/apps").then((r) => r.json()).then((data) => {
      setApps(data.apps);
      if (data.apps.length && !selectedAppId) setSelectedAppId(data.apps[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 拉统计数据
  useEffect(() => {
    if (!selectedAppId) return;
    const params = new URLSearchParams();
    params.set("appId", selectedAppId);
    params.set("since", since);
    if (locale) params.set("locale", locale);
    fetch(`/api/demo/stats?${params}`).then((r) => r.json()).then(setStats);
  }, [selectedAppId, locale, since]);

  // 拉评论列表（筛选/翻页变化时）
  useEffect(() => {
    if (!selectedAppId) return;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("appId", selectedAppId);
    params.set("since", since);
    if (locale) params.set("locale", locale);
    if (tagFilter) params.set("tag", tagFilter);
    if (search) params.set("q", search);
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    fetch(`/api/demo/reviews?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setReviews(data.items);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [selectedAppId, locale, tagFilter, search, page, since]);

  // 切筛选条件时回到第一页
  useEffect(() => { setPage(1); }, [selectedAppId, locale, tagFilter, search, since]);

  // 预设问答（基于真实统计生成，统计加载完才有内容）
  const presetQAs = useMemo(() => {
    if (!stats) return {};
    const topTags = Object.entries(stats.tagCounts).sort((a, b) => b[1].count - a[1].count);
    const worstVersion = [...stats.versionStats].filter((v) => v.count >= 5).sort((a, b) => a.avgRating - b.avgRating)[0];
    const topTagLine = topTags.slice(0, 3).map(([, t], i) => `${i + 1}. **${t.label}**：${t.count} 条`).join("\n");
    return {
      [`${timeRangeLabel}用户主要在反馈什么问题？`]: topTagLine || "暂无数据",
      "哪个版本评价最差？": worstVersion
        ? `版本 ${worstVersion.version}：均分 ${worstVersion.avgRating} ★（${worstVersion.count} 条评论）`
        : "样本里版本评论数太少，暂无法判断",
      "官方回复率怎么样？": `${timeRangeLabel} ${stats.total} 条评论中，${stats.officialReplyRate}% 收到了 ${appName} 官方回复。`,
    } as Record<string, string>;
  }, [stats, timeRangeLabel, appName]);

  function handleSendChat() {
    const q = chatInput.trim();
    if (!q) return;
    const a = presetQAs[q] ?? `这是基于${timeRangeLabel}公开评论抽样的真实统计 Demo，目前只能回答左侧预设问题；接入真实账号后可以追问任意问题。`;
    setChatMessages((prev) => [...prev, { q, a }]);
    setChatInput("");
  }

  function handleSelectReview(r: ReviewRow) {
    setSelectedReview(r);
    setAiReply("");
    setAiError("");
  }

  function toggleExpand(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleGenerateAiReply() {
    if (!selectedReview) return;
    setAiLoading(true);
    setAiError("");
    try {
      const res = await fetch("/api/demo/ai-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: selectedReview.content,
          rating: selectedReview.rating,
          tags: selectedReview.ai_tags,
          author: selectedReview.author,
          officialReply: selectedReview.official_reply,
          appId: selectedAppId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error || "生成失败");
      } else {
        setAiReply(data.reply);
      }
    } catch {
      setAiError("请求失败，请重试");
    } finally {
      setAiLoading(false);
    }
  }

  function jumpToTag(tag: string) {
    setTagFilter(tag);
    setLocale(undefined);
    setActivePanel("reply");
    setMobileTab("analyze");
  }

  const rightPanelItems: { key: RightPanel; label: string; icon: React.ReactNode }[] = [
    { key: "complaints", label: "Top 反馈", icon: <TrendingDown size={14} /> },
    { key: "comparison", label: "版本分析", icon: <GitCompare size={14} /> },
    { key: "demands", label: "诉求清单", icon: <ListTodo size={14} /> },
    { key: "reply", label: "评论回复", icon: <Reply size={14} /> },
  ];

  const totalTagCount = stats ? Object.values(stats.tagCounts).reduce((a, b) => a + b.count, 0) : 0;
  // "全部"要跟当前选的 locale 无关，不能直接用 stats.total（那是按 locale 筛过的），用 localeCounts 求和才是真正的全量
  const allLocalesTotal = stats ? Object.values(stats.localeCounts).reduce((a, b) => a + b, 0) : 0;
  const avgRating = stats
    ? Math.round(
        (Object.entries(stats.ratingDist).reduce((sum, [k, v]) => sum + Number(k) * v, 0) / stats.total) * 100
      ) / 100
    : null;

  // ── 中间区域：分析结果 ──
  const AnalyzeResult = (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      {activePanel === "complaints" && stats && (
        <div>
          <p className="text-white/65 text-[14px] mb-4">
            {timeRangeLabel}（{fmtDate(stats.dateRange.from)} ~ {fmtDate(stats.dateRange.to)}）共 {stats.total} 条公开评论，AI 按问题类型聚类（点击查看该类全部真实评论）：
          </p>
          <div className="flex flex-col gap-3">
            {Object.entries(stats.tagCounts)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([tag, t], i) => {
                const pct = (t.count / stats.total) * 100;
                return (
                  <button key={tag} onClick={() => jumpToTag(tag)}
                    className="text-left bg-[#1e2026] hover:bg-white/10 transition-colors rounded-xl p-4 flex items-center gap-4">
                    <DonutPercent percent={pct} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-white/45 text-[14px] font-mono">#{i + 1}</span>
                        <span className="text-white/90 text-[16px] font-medium">{t.label}</span>
                      </div>
                      <p className="text-white/55 text-[13px] leading-relaxed">
                        {t.count} 条评论{t.summary ? t.summary : "，点击查看全部真实评论 →"}
                      </p>
                    </div>
                  </button>
                );
              })}
          </div>
          <p className="text-white/25 text-[12px] mt-4 leading-relaxed">
            数据来源：Google Play 公开评论抽样（非 {appName} 官方授权接入），DeepSeek 真实分类，共 {totalTagCount} 次标签命中（一条评论可能命中多个类型）。
          </p>
        </div>
      )}

      {activePanel === "comparison" && stats && (
        <div>
          <div className="flex items-baseline gap-3 mb-1">
            <span className="text-[42px] font-bold text-white">{avgRating}</span>
            <span className="text-white/55 text-[16px]">{timeRangeLabel}平均分</span>
          </div>
          <p className="text-white/45 text-[14px] mb-5">
            {appName} · {fmtDate(stats.dateRange.from)} ~ {fmtDate(stats.dateRange.to)} · Google Play · 按版本号统计（仅统计评论里带版本号的 {stats.versionStats.reduce((s, v) => s + v.count, 0)} 条）
          </p>
          <div className="flex items-end gap-2 h-[200px] px-1 border-b border-white/10 relative">
            {avgRating && (
              <div className="absolute left-0 right-0 border-t border-dashed border-violet-400/50 flex items-center"
                style={{ bottom: `${(avgRating / 5) * 180}px` }}>
                <span className="text-violet-400 text-[10px] bg-[#181a1f] px-1 -translate-y-1/2">整体均分 {avgRating}</span>
              </div>
            )}
            {stats.versionStats.map((v) => {
              const color = v.avgRating < 3 ? "#ef4444" : v.avgRating < 4 ? "#f59e0b" : "#10b981";
              return (
                <div key={v.version} className="group relative flex-1 flex flex-col items-center justify-end h-full min-w-0">
                  <div className="absolute -top-5 text-white/55 text-[11px] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                    {v.avgRating} ★ · {v.count} 条
                  </div>
                  <div className="w-full rounded-t transition-opacity group-hover:opacity-80"
                    style={{ height: `${(v.avgRating / 5) * 180}px`, backgroundColor: color, minHeight: 2 }} />
                  <div className="text-white/40 text-[10px] font-mono mt-1.5 -rotate-45 origin-top-left whitespace-nowrap translate-x-2">
                    {v.version}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-white/25 text-[12px] mt-3 leading-relaxed">
            App Store 端 Apple 官方 API 不返回评论对应版本号，只能靠评论日期 vs 版本发布时间线做推断分析，这里展示的是 Google Play 真实版本字段统计。
          </p>
        </div>
      )}

      {activePanel === "demands" && stats && (() => {
        // 不假定哪两个 tag 是最大诉求——"求加新功能"和"正面评价"排除在外，剩下按真实命中量取前二，
        // 换一个 App（最大问题可能是广告或登录而不是扣费/bug）这段结论照样成立
        const sorted = Object.entries(stats.tagCounts).sort((a, b) => b[1].count - a[1].count);
        const topComplaints = sorted.filter(([tag]) => tag !== "praise" && tag !== "feature_request").slice(0, 2);
        const topComplaintsLabel = topComplaints.map(([, t]) => t.label).join("和");
        const topComplaintsCount = topComplaints.reduce((sum, [, t]) => sum + t.count, 0);
        const topComplaintsPct = stats.total ? Math.round((topComplaintsCount / stats.total) * 100) : 0;
        const featureReq = stats.tagCounts.feature_request;
        const featureReqPct = stats.total ? Math.round(((featureReq?.count ?? 0) / stats.total) * 1000) / 10 : 0;
        return (
          <div>
            <p className="text-white/65 text-[14px] mb-4">
              真实数据画像：按 AI 分类命中量排序，{topComplaintsLabel ? `"${topComplaintsLabel}"是${timeRangeLabel}最大的诉求` : "暂无足够数据"}，"求加新功能"只占很小一部分：
            </p>
            <div className="flex flex-col gap-3">
              {sorted.map(([tag, t], i) => {
                const pct = (t.count / stats.total) * 100;
                return (
                  <button key={tag} onClick={() => jumpToTag(tag)}
                    className="text-left bg-[#1e2026] hover:bg-white/10 transition-colors rounded-xl p-4 flex items-center gap-4">
                    <DonutPercent percent={pct} color="#10b981" />
                    <div className="flex-1 min-w-0">
                      <span className="text-white/90 text-[16px] font-medium">#{i + 1} {t.label}</span>
                      <p className="text-white/55 text-[13px] leading-relaxed">{t.count} 条评论{t.summary ?? ""}</p>
                    </div>
                  </button>
                );
              })}
            </div>
            {topComplaints.length > 0 && (
              <div className="bg-emerald-950/30 rounded-xl p-4 mt-4">
                <p className="text-emerald-400 text-[14px] font-medium mb-1">真实结论</p>
                <p className="text-white/70 text-[14px] leading-relaxed">
                  {topComplaintsLabel}合计占{timeRangeLabel}评论的 {topComplaintsPct}%，而求加新功能只有 {featureReq?.count ?? 0} 条（{featureReqPct}%）——先堵住{topComplaintsLabel}这类问题，比做新功能性价比更高。
                </p>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );

  // ── 中间区域：回复模式 ──
  const ReplyResult = (
    <div className="flex-1 flex flex-col overflow-hidden">
      {tagFilter && stats?.tagCounts[tagFilter] && (
        <div className="flex items-center gap-4 px-4 pt-4 flex-none">
          <DonutPercent percent={(stats.tagCounts[tagFilter].count / stats.total) * 100} size={48} />
          <div className="min-w-0">
            <p className="text-white/90 text-[15px] font-medium">{stats.tagCounts[tagFilter].label}</p>
            <p className="text-white/55 text-[13px] leading-relaxed">
              {stats.tagCounts[tagFilter].count} 条评论{stats.tagCounts[tagFilter].summary ?? ""}
            </p>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-2 flex-none">
        <div className="relative flex-1 min-w-[160px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
            placeholder="搜索评论内容/作者..."
            className="w-full bg-[#1e2026] border border-white/14 rounded-lg pl-8 pr-3 py-1.5 text-[13px] text-white placeholder-white/25 outline-none focus:border-white/30" />
        </div>
        {tagFilter && (
          <button onClick={() => setTagFilter(undefined)}
            className="flex items-center gap-1 px-3 py-1 rounded-full text-[12px] bg-white/15 text-white/90">
            {stats?.tagCounts[tagFilter]?.label ?? tagFilter} <X size={11} />
          </button>
        )}
        {search && (
          <button onClick={() => { setSearch(""); setSearchInput(""); }}
            className="flex items-center gap-1 px-3 py-1 rounded-full text-[12px] bg-white/15 text-white/90">
            "{search}" <X size={11} />
          </button>
        )}
        <div className="relative">
          <button onClick={() => setShowTranslateSettings((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
              translateSettings.enabled ? "bg-white/12 text-white/80" : "bg-white/6 text-white/45"
            }`}>
            <Settings size={12} />翻译
          </button>
          {showTranslateSettings && (
            <div className="absolute right-0 top-full mt-1.5 z-10 w-56 bg-[#1e2026] border border-white/14 rounded-xl p-3 shadow-xl flex flex-col gap-3">
              <label className="flex items-center justify-between text-[13px] text-white/80">
                启用翻译
                <input type="checkbox" checked={translateSettings.enabled}
                  onChange={(e) => setTranslateSettings((s) => ({ ...s, enabled: e.target.checked }))} />
              </label>
              <div>
                <p className="text-white/35 text-[11px] uppercase tracking-wider mb-1.5">目标语言</p>
                {([["zh", "中文"], ["en", "英文"]] as const).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-2 text-[13px] text-white/70 py-0.5">
                    <input type="radio" checked={translateSettings.targetLang === v}
                      onChange={() => setTranslateSettings((s) => ({ ...s, targetLang: v }))} />
                    {label}
                  </label>
                ))}
              </div>
              <div>
                <p className="text-white/35 text-[11px] uppercase tracking-wider mb-1.5">翻译范围</p>
                {([
                  ["non_target", "翻译所有非目标语言"],
                  ["non_zh_en", "只翻译非中英文（保留英文原文）"],
                ] as const).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-2 text-[13px] text-white/70 py-0.5">
                    <input type="radio" checked={translateSettings.scope === v}
                      onChange={() => setTranslateSettings((s) => ({ ...s, scope: v }))} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="flex items-center justify-center h-full text-white/30"><Loader2 className="animate-spin" size={20} /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {reviews.map((r) => {
              const isSelected = selectedReview?.id === r.id;
              const isExpanded = expandedIds.has(r.id);
              const display = getDisplayContent(r, translateSettings);
              // 没法精确算渲染后是否真的被截断，用字数估个大概，宁可偶尔多显示一次"展开"也不要漏掉真正被截断的
              const mayBeTruncated = display.text.length > 70;
              return (
                <button key={r.id} onClick={() => handleSelectReview(r)}
                  className={`text-left rounded-xl p-4 transition-all ${
                    isSelected ? "ring-1 ring-white/25 bg-white/12" : "bg-[#1e2026] hover:bg-white/10"
                  }`}>
                  <div className="flex items-center justify-between mb-2">
                    <Stars rating={r.rating ?? 0} />
                    <div className="flex items-center gap-1.5">
                      <span className="text-white/45 text-[12px]">{localeLabel(r.locale)}</span>
                      {r.app_version && (
                        <span className="text-[12px] px-1.5 py-0.5 rounded font-mono bg-[#2a2c32] text-white/55">{r.app_version}</span>
                      )}
                    </div>
                  </div>
                  <p className={`text-white/70 text-[14px] leading-relaxed mb-1 ${isExpanded ? "" : "line-clamp-3"}`}>{display.text}</p>
                  {mayBeTruncated && (
                    <span onClick={(e) => toggleExpand(r.id, e)}
                      className="text-white/35 hover:text-white/60 text-[12px] mb-1 inline-block">
                      {isExpanded ? "收起" : "展开全文"}
                    </span>
                  )}
                  {display.translated && <p className="text-white/25 text-[11px] mb-2">已自动翻译</p>}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-white/45 text-[12px]">{r.author} · {fmtDate(r.review_date)}</span>
                    {r.official_reply && <span className="text-white/35 text-[12px]">有官方回复</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 mt-4 text-[13px] text-white/55">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 rounded-lg bg-white/8 disabled:opacity-30">上一页</button>
            <span>第 {page} / {Math.ceil(total / PAGE_SIZE)} 页 · 共 {total} 条</span>
            <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded-lg bg-white/8 disabled:opacity-30">下一页</button>
          </div>
        )}
      </div>

      {/* 回复详情 / AI 回复 */}
      <div className="border-t border-white/14 p-4">
        {selectedReview ? (
          <div className="flex flex-col gap-2">
            {(() => {
              const display = getDisplayContent(selectedReview, translateSettings);
              return (
                <div className="bg-white/5 rounded-lg px-3 py-2">
                  <p className="text-white/45 text-[12px] mb-0.5">评论原文</p>
                  <p className="text-white/80 text-[13px] leading-relaxed whitespace-pre-line max-h-32 overflow-y-auto">
                    {selectedReview.content}
                  </p>
                  {display.translated && (
                    <>
                      <p className="text-white/45 text-[12px] mt-2 mb-0.5">译文</p>
                      <p className="text-white/70 text-[13px] leading-relaxed whitespace-pre-line max-h-32 overflow-y-auto">
                        {display.text}
                      </p>
                    </>
                  )}
                </div>
              );
            })()}
            {selectedReview.official_reply && (
              <div className="bg-white/5 rounded-lg px-3 py-2">
                <p className="text-white/45 text-[12px] mb-0.5">{appName} 官方曾这样回复（公开信息，模板化覆盖海量评论）</p>
                <p className="text-white/55 text-[13px] leading-relaxed line-clamp-2">{selectedReview.official_reply}</p>
              </div>
            )}
            <div className="bg-white/8 rounded-lg px-3 py-2">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="text-white/70 text-[13px]">呼声雷达 AI 针对这条的个性化回复建议</p>
                <button onClick={() => setSelectedReview(null)} className="text-white/20 hover:text-white/65 transition-colors"><X size={14} /></button>
              </div>
              {aiReply ? (
                <p className="text-white/85 text-[14px] leading-relaxed whitespace-pre-line">{aiReply}</p>
              ) : (
                <button onClick={handleGenerateAiReply} disabled={aiLoading}
                  className="flex items-center gap-1.5 text-[13px] text-white/70 bg-white/10 hover:bg-white/15 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors">
                  {aiLoading && <Loader2 size={12} className="animate-spin" />}
                  {aiLoading ? "生成中..." : "生成 AI 回复建议"}
                </button>
              )}
              {aiError && <p className="text-red-400 text-[12px] mt-1.5">{aiError}</p>}
            </div>
          </div>
        ) : (
          <p className="text-white/25 text-[14px] px-1">点击左侧评论卡片，查看 AI 回复建议</p>
        )}
      </div>
    </div>
  );

  // ── 左栏 ──
  const LeftPanel = (
    <div className={`flex-none flex flex-col gap-1.5 transition-[width] duration-200 ease-in-out ${leftOpen ? "w-52" : "w-12"}`}>
      <div className="h-8 flex items-center overflow-hidden">
        <Link href="/"
          className={`px-2 text-xl tracking-tight text-white whitespace-nowrap transition-opacity duration-150 ${leftOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          style={{ fontFamily: "'smiley-sans', sans-serif" }}>
          呼声雷达
        </Link>
      </div>
      <GlassPanel className="flex flex-col overflow-hidden rounded-2xl flex-1">
        <div className="px-3 pb-2.5 pt-2.5 flex items-center justify-between border-b border-white/14 flex-none">
          <button onClick={() => setLeftOpen(!leftOpen)}
            className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition-colors flex-none">
            <PanelLeft size={20} strokeWidth={1.5} />
          </button>
          <span className={`text-white/65 text-[13px] font-medium transition-opacity duration-150 ${leftOpen ? "opacity-100" : "opacity-0"}`}>筛选</span>
        </div>
        <div className={`flex-1 flex flex-col overflow-hidden transition-opacity duration-150 ${leftOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
          <div className="py-2 flex items-center justify-center gap-3">
            <button onClick={() => setPlatform("googleplay")}
              className={`p-2.5 rounded-xl transition-colors ${platform === "googleplay" ? "bg-white/12 ring-1 ring-white/20" : "hover:bg-white/10"}`}>
              <img src="/Google_Play_2022_icon.svg.png" alt="Google Play" className="w-7 h-7" />
            </button>
            <button onClick={() => setPlatform("appstore")} title="暂无数据"
              className={`p-2.5 rounded-xl transition-colors relative ${platform === "appstore" ? "bg-white/12 ring-1 ring-white/20" : "hover:bg-white/10"}`}>
              <img src="/App_Store_(iOS).svg.png" alt="App Store" className="w-7 h-7 opacity-40" />
            </button>
          </div>
          <div className="border-t border-white/10" />
          <div className="py-2 px-3">
            <select value={selectedAppId ?? ""} onChange={(e) => setSelectedAppId(e.target.value)}
              className="w-full bg-white/8 hover:bg-white/12 transition-colors rounded-lg px-2.5 py-1.5 text-[13px] text-white/85 outline-none cursor-pointer">
              {apps.map((a) => (
                <option key={a.id} value={a.id} className="bg-[#1e2026]">{a.display_name}</option>
              ))}
            </select>
          </div>
          <div className="border-t border-white/10" />
          <div className="py-2 px-3 flex items-center justify-center gap-1.5">
            {(["week", "month"] as TimeRange[]).map((t) => (
              <button key={t} onClick={() => setTimeRange(t)}
                className={`px-3 py-1 rounded-full text-[12px] font-mono transition-colors ${timeRange === t ? "bg-white/15 text-white/90" : "text-white/45 hover:text-white/70 hover:bg-white/8"}`}>
                {t === "week" ? "最近一周" : "最近一月"}
              </button>
            ))}
          </div>
          <div className="border-t border-white/10" />
          {platform === "googleplay" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1 text-[14px]">
              <p className="text-white/35 uppercase tracking-wider text-[12px] mb-1.5 px-1">地区/语言批次 · Google Play</p>
              <button onClick={() => setLocale(undefined)}
                className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg transition-colors ${!locale ? "bg-white/12 text-white/80" : "text-white/55 hover:text-white/70 hover:bg-white/10"}`}>
                <Languages size={12} /><span>全部 {stats ? `(${allLocalesTotal})` : ""}</span>
              </button>
              {stats && Object.entries(stats.localeCounts).sort((a, b) => b[1] - a[1]).map(([l, count]) => (
                <button key={l} onClick={() => setLocale(l)}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg transition-colors ${locale === l ? "bg-white/12 text-white/80" : "text-white/55 hover:text-white/70 hover:bg-white/10"}`}>
                  <Languages size={12} /><span>{localeLabel(l)} ({count})</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center px-3">
              <p className="text-white/25 text-[12px] text-center leading-relaxed">App Store 这次没有抓取公开评论数据，暂不支持筛选</p>
            </div>
          )}
        </div>
      </GlassPanel>
    </div>
  );

  // ── 中栏 ──
  const CenterPanel = (
    <GlassPanel className="flex-1 flex flex-col overflow-hidden rounded-2xl min-w-0">
      <div className="px-3 py-2.5 border-b border-white/14 flex items-center justify-between flex-none gap-3">
        <div className="flex items-center gap-1 overflow-x-auto">
          {rightPanelItems.map((item) => (
            <button key={item.key} onClick={() => setActivePanel(item.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] whitespace-nowrap transition-colors ${
                activePanel === item.key ? "bg-white/12 text-white/90" : "text-white/45 hover:text-white/70 hover:bg-white/8"
              }`}>
              {item.icon}
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </div>
        <span className="text-white/35 text-[14px] flex-none">{stats ? `${stats.total} 条评论` : "加载中..."}</span>
      </div>

      {isReplyMode ? ReplyResult : AnalyzeResult}

      {!isReplyMode && (
        <div className="border-t border-white/14 p-4 flex-none">
          {chatMessages.length > 0 && (
            <div className="mb-3 max-h-36 overflow-y-auto flex flex-col gap-2">
              {chatMessages.map((m, i) => (
                <div key={i} className="text-[14px]">
                  <p className="text-white/55 mb-0.5">你：{m.q}</p>
                  <p className="text-white/70 bg-[#1e2026] rounded-lg px-3 py-2 leading-relaxed whitespace-pre-line">{m.a}</p>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {Object.keys(presetQAs).map((q) => (
              <button key={q} onClick={() => { setChatInput(q); }}
                className="text-[12px] px-2.5 py-1 rounded-full bg-white/8 hover:bg-white/14 text-white/55 transition-colors">
                {q}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
              placeholder="问我关于这款 App 的任何问题..."
              className="flex-1 bg-[#1e2026] border border-white/14 rounded-xl px-4 py-2.5 text-[16px] text-white placeholder-white/25 outline-none focus:border-white/30 transition-colors" />
            <button onClick={handleSendChat}
              className="bg-[rgb(55,57,62)] hover:bg-[rgb(75,78,84)] text-white px-4 rounded-xl transition-colors flex items-center gap-1.5 text-[16px] font-medium">
              <Send size={13} />
            </button>
          </div>
        </div>
      )}
    </GlassPanel>
  );

  return (
    <div className="h-screen flex flex-col font-[family-name:var(--font-geist)] overflow-hidden"
      style={{ background: "#0b0c0e" }}>

      <div className="hidden md:flex flex-1 overflow-hidden p-3 gap-3">
        {LeftPanel}
        {CenterPanel}
      </div>

      <div className="flex md:hidden flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden p-3">
          {mobileTab === "filter" && (
            <GlassPanel className="h-full rounded-2xl overflow-y-auto p-4">
              <p className="text-white/55 text-[14px] uppercase tracking-wider mb-4">筛选条件</p>
              <div className="flex flex-col gap-5">
                <div>
                  <p className="text-white/35 text-[12px] uppercase tracking-wider mb-2">App</p>
                  <select value={selectedAppId ?? ""} onChange={(e) => setSelectedAppId(e.target.value)}
                    className="w-full bg-white/8 rounded-lg px-3 py-2 text-[16px] text-white/85 outline-none">
                    {apps.map((a) => (
                      <option key={a.id} value={a.id} className="bg-[#1e2026]">{a.display_name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <p className="text-white/35 text-[12px] uppercase tracking-wider mb-2">时间范围</p>
                  <div className="flex gap-2">
                    {(["week", "month"] as TimeRange[]).map((t) => (
                      <button key={t} onClick={() => setTimeRange(t)}
                        className={`px-3 py-1.5 rounded-full text-[14px] font-mono transition-colors ${timeRange === t ? "bg-white/15 text-white/90" : "text-white/55 hover:bg-white/10"}`}>
                        {t === "week" ? "最近一周" : "最近一月"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-white/35 text-[12px] uppercase tracking-wider mb-2">平台</p>
                  {(["googleplay", "appstore"] as Platform[]).map((p) => (
                    <button key={p} onClick={() => setPlatform(p)}
                      className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg mb-1 text-[16px] transition-colors ${platform === p ? "bg-white/12 text-white/90" : "text-white/65 hover:bg-white/10"}`}>
                      {p === "appstore" ? "App Store（暂无数据）" : "Google Play"}
                    </button>
                  ))}
                </div>
                {platform === "googleplay" && stats && (
                  <div>
                    <p className="text-white/35 text-[12px] uppercase tracking-wider mb-2">地区/语言批次 · Google Play</p>
                    <button onClick={() => setLocale(undefined)}
                      className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg mb-1 text-[16px] transition-colors ${!locale ? "bg-white/12 text-white/90" : "text-white/65 hover:bg-white/10"}`}>
                      <Languages size={13} />全部 ({allLocalesTotal})
                    </button>
                    {Object.entries(stats.localeCounts).sort((a, b) => b[1] - a[1]).map(([l, count]) => (
                      <button key={l} onClick={() => setLocale(l)}
                        className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg mb-1 text-[16px] transition-colors ${locale === l ? "bg-white/12 text-white/90" : "text-white/65 hover:bg-white/10"}`}>
                        <Languages size={13} />{localeLabel(l)} ({count})
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </GlassPanel>
          )}

          {mobileTab === "analyze" && CenterPanel}
        </div>

        <div className="bg-[#181a1f] border-t border-white/10 flex">
          {([
            { key: "filter", label: "筛选", icon: <Layers size={18} /> },
            { key: "analyze", label: "分析", icon: <BarChart2 size={18} /> },
          ] as { key: MobileTab; label: string; icon: React.ReactNode }[]).map((tab) => (
            <button key={tab.key} onClick={() => setMobileTab(tab.key)}
              className={`flex-1 flex flex-col items-center py-3 gap-1 text-[13px] transition-colors ${mobileTab === tab.key ? "text-white/80" : "text-white/35"}`}>
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
