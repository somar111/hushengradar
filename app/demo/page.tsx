"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Globe,
  ListOrdered, GitCompare, Bot, Reply,
  X, BarChart2, LineChart, PanelLeft, Search, Loader2, Settings, ChevronDown, Info, ArrowUp,
} from "lucide-react";
import { type ReviewRow, type AppRow } from "@/lib/supabase";
import { meaningfulLocaleFloor } from "@/lib/analysisShared";
import type { Insights } from "@/lib/classify";
import { useQueryState, useQueryParams } from "@/lib/useQueryState";

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
  tagCounts: Record<
    string,
    { label: string; count: number; summary: string | null; repliedCount: number; subTags: Record<string, { label: string; count: number }> }
  >;
  localeCounts: Record<string, number>;
  localeRatings: { locale: string; count: number; avgRating: number }[];
  versionStats: { version: string; count: number; avgRating: number; avgDate: number }[];
  dailyRatings: { date: string; avgRating: number; count: number }[];
  officialReplyRate: number;
};

type RightPanel = "complaints" | "analysis" | "ask" | "reply";
type Platform = "googleplay" | "appstore";
type TargetLang = "zh" | "en";
type TranslateScope = "non_target" | "non_zh_en";
type TimeRange = "week" | "month";
type ChatMessage = {
  id: string;
  q: string;
  a: string;
};

type TranslateSettings = {
  enabled: boolean;
  targetLang: TargetLang;
  scope: TranslateScope;
};

const PAGE_SIZE = 200;
const ASK_DRAFT_STORAGE_PREFIX = "hushengradar.askDraft.v1";

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

// 纯展示的信息小图标：用 position:fixed 算坐标弹出说明文字，不用浏览器原生 title
// ——原生 title 在窄边栏的滚动容器里经常被 overflow 裁掉，而且字号没法自定义
function InfoTooltip({ text, size = 14 }: { text: string; size?: number }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      onMouseEnter={() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) setPos({ top: rect.bottom + 6, left: rect.left });
      }}
      onMouseLeave={() => setPos(null)}
      className="inline-flex flex-none"
    >
      <Info size={size} className="text-white/40" />
      {pos && (
        <span
          className="fixed z-50 w-60 bg-[#383838] border border-white/15 text-white/90 text-[14px] leading-relaxed rounded-lg px-3 py-2 shadow-xl normal-case font-normal tracking-normal"
          style={{ top: pos.top, left: pos.left }}>
          {text}
        </span>
      )}
    </span>
  );
}

// 主题强调色：跟 Claude Code 用量统计图的蓝色对齐（从截图实测取色 rgb(87,129,216)）
const THEME_BLUE = "#5781d8";

// 分段切换器统一样式：深色轨道 + 选中态是一块"磨砂玻璃胶囊"（半透明白底、上缘高光、细边、
// 轻投影），轨道 p-1 让选中胶囊四周等距内嵌、外缘跟轨道对齐。右侧导航/时间范围/评分分析
// 子切换都用同一套，保证观感一致。
const SEG_TRACK = "flex items-center gap-1 bg-white/6 rounded-full p-1";
const SEG_PILL_ON = "bg-white/15 text-white ring-1 ring-white/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.28),0_1px_2px_0_rgba(0,0,0,0.35)] backdrop-blur-sm";
const SEG_PILL_OFF = "text-white/60 hover:text-white/85";

// "分析"现在由AI现场生成，请求没回来之前显示这个，而不是先空着再突然蹦出文字
function InsightsLoading() {
  return (
    <div className="flex items-center gap-2 text-white/35 text-[13px] mt-4">
      <Loader2 size={12} className="animate-spin" />正在分析…
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="mb-4 mt-1 text-[34px] leading-[1.2] font-bold text-white">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-3 mt-1 text-[28px] leading-[1.25] font-bold text-white">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-3 mt-1 text-[23px] leading-[1.3] font-semibold text-white">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-2.5 mt-1 text-[20px] leading-[1.35] font-semibold text-white">{children}</h4>,
        p: ({ children }) => <p className="mb-4 last:mb-0 leading-[1.95] text-[17px]">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-6 mb-4 space-y-1.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-6 mb-4 space-y-1.5">{children}</ol>,
        li: ({ children }) => <li className="leading-[1.9] text-[17px]">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
        code: ({ children }) => <code className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 text-[15px]">{children}</code>,
        pre: ({ children }) => <pre className="overflow-x-auto rounded-xl bg-black/25 p-4 mb-4 text-[15px] leading-relaxed">{children}</pre>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-white/25 pl-4 text-white/80 mb-4 leading-[1.9]">{children}</blockquote>
        ),
      }}>
      {content}
    </ReactMarkdown>
  );
}

function charDelay(ch: string) {
  if (ch === "\n") return 0;
  if ("。！？!?".includes(ch)) return 140;
  if ("，、,:;；".includes(ch)) return 50;
  return 12;
}

function DonutPercent({ percent, size = 40, color = THEME_BLUE }: { percent: number; size?: number; color?: string }) {
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

// 通用分类调色板：不跟任何具体 tag key 绑定，按排序后的序号循环取色，换 App/换标签体系都适用
const CATEGORY_PALETTE = [THEME_BLUE, "#10b981", "#f59e0b", "#ef4444", "#a78bfa", "#06b6d4", "#ec4899", "#84cc16"];

function PieBreakdown({
  slices, size = 140, hoveredKey, onHoverKey,
}: {
  slices: { key: string; count: number; color: string }[];
  size?: number;
  hoveredKey?: string | null;
  onHoverKey?: (key: string | null) => void;
}) {
  const total = slices.reduce((s, d) => s + d.count, 0) || 1;
  const r = size / 2 - size * 0.14;
  const c = 2 * Math.PI * r;
  const baseStroke = size * 0.16;
  const hoverStroke = size * 0.21;
  let cumulative = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="flex-none overflow-visible">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#ffffff10" strokeWidth={baseStroke} />
      {slices.map((s) => {
        const frac = s.count / total;
        const dash = frac * c;
        const rotate = (cumulative / total) * 360 - 90;
        cumulative += s.count;
        if (dash <= 0) return null;
        const isHovered = hoveredKey === s.key;
        const isDimmed = hoveredKey != null && !isHovered;
        return (
          <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color}
            strokeWidth={isHovered ? hoverStroke : baseStroke}
            strokeOpacity={isDimmed ? 0.35 : 1}
            strokeDasharray={`${dash} ${c - dash}`} transform={`rotate(${rotate} ${size / 2} ${size / 2})`}
            className="transition-all cursor-pointer"
            onMouseEnter={() => onHoverKey?.(s.key)} onMouseLeave={() => onHoverKey?.(null)} />
        );
      })}
    </svg>
  );
}

// 评分随真实日期走的折线图：横轴按实际天数间距（不是均匀分类摆放），纵轴固定 1~5（评分本身的
// 天然量程，不做自动缩放，避免轴范围操纵带来的误导）；点的大小/透明度按当天评论量加权，
// 评论数少的那天视觉上自然淡一点小一点，不会被误读成强信号
function RatingTrendChart({ points, height = 200 }: { points: { date: string; avgRating: number; count: number }[]; height?: number }) {
  if (points.length === 0) {
    return <div style={{ height }} className="flex items-center justify-center text-white/35 text-[13px]">暂无数据</div>;
  }
  const width = 1000;
  const minTime = new Date(points[0].date).getTime();
  const maxTime = new Date(points[points.length - 1].date).getTime();
  const timeSpan = Math.max(maxTime - minTime, 86400000);
  const x = (date: string) => ((new Date(date).getTime() - minTime) / timeSpan) * width;
  const y = (rating: number) => height - ((rating - 1) / 4) * height;
  const maxCount = Math.max(...points.map((p) => p.count), 1);
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.date).toFixed(1)} ${y(p.avgRating).toFixed(1)}`).join(" ");
  const labelEvery = points.length > 12 ? Math.ceil(points.length / 8) : 1;

  return (
    <svg viewBox={`0 0 ${width} ${height + 22}`} className="w-full" style={{ height: height + 22 }} preserveAspectRatio="none">
      <path d={pathD} fill="none" stroke={THEME_BLUE} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      {points.map((p) => {
        const r = 2.5 + (p.count / maxCount) * 4.5;
        const opacity = 0.4 + (p.count / maxCount) * 0.6;
        return (
          <circle key={p.date} cx={x(p.date)} cy={y(p.avgRating)} r={r} fill={THEME_BLUE} opacity={opacity}>
            <title>{p.date}：均分 {p.avgRating}，{p.count} 条评论</title>
          </circle>
        );
      })}
      {points.map((p, i) => (
        i % labelEvery === 0 && (
          <text key={p.date} x={x(p.date)} y={height + 16} fontSize={10} fill="#ffffff66"
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
            {p.date.slice(5)}
          </text>
        )
      ))}
    </svg>
  );
}

function fmtDate(iso: string | null) {
  return iso ? iso.slice(0, 10) : "—";
}

// "Top反馈"和"评论回复"头部用同一份子问题数据、同一个组件渲染，保证两处展示的子问题永远
// 一一对应——子问题各自带真实数字、可点击；没有子问题时退回AI摘要（比如"意义不明的纯抱怨"
// 这种本就没有子问题的类别，或还没重分类过的老数据）。onJump 给了就可点：传子问题 key 跳到
// 该子问题，传 undefined 跳到整个标签；没给 onJump 就是纯展示。activeSubKey 高亮当前选中的子问题。
function TagBreakdown({ t, onJump, activeSubKey }: {
  t: { count: number; summary: string | null; subTags: Record<string, { label: string; count: number }> };
  onJump?: (subKey?: string) => void;
  activeSubKey?: string;
}) {
  const subEntries = Object.entries(t.subTags).sort((a, b) => b[1].count - a[1].count);
  if (subEntries.length === 0) {
    const text = t.summary || "点击查看全部真实评论 →";
    return onJump
      ? <button onClick={(e) => { e.stopPropagation(); onJump(); }}
          className="text-white/68 text-[13px] leading-relaxed text-left hover:text-white/90 transition-colors">{text}</button>
      : <span className="text-white/68 text-[13px] leading-relaxed">{text}</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {subEntries.map(([key, s]) => {
        const content = `${s.label}（${s.count}）`;
        const active = activeSubKey === key;
        return onJump ? (
          <button key={key} onClick={(e) => { e.stopPropagation(); onJump(key); }}
            className={`text-[13px] px-2 py-0.5 rounded-md transition-colors ${
              active ? "bg-white/20 text-white" : "bg-white/5 text-white/68 hover:bg-white/12 hover:text-white/90"
            }`}>{content}</button>
        ) : (
          <span key={key} className="text-[13px] px-2 py-0.5 rounded-md bg-white/5 text-white/68">{content}</span>
        );
      })}
    </div>
  );
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

// 筛选/导航类状态同步进 URL query string——分享链接、浏览器前进后退都对这些字段生效。
// 跟具体 App、具体数据无关，纯 UI 状态（侧栏开合、hover 高亮等）不进 URL，见下方各自的 useState。
export default function DemoPage() {
  return (
    <Suspense fallback={null}>
      <DemoPageInner />
    </Suspense>
  );
}

function DemoPageInner() {
  const [leftOpen, setLeftOpen] = useState(true);
  // 一次改多个 URL 参数走这个，避免连着调多个单参数 setter 互相覆盖（见 useQueryState.ts 注释）
  const setParams = useQueryParams();
  const [activePanelRaw, setActivePanelRaw] = useQueryState("panel", "complaints");
  const activePanel = activePanelRaw as RightPanel;
  const setActivePanel = setActivePanelRaw as (v: RightPanel) => void;
  const [platformRaw, setPlatformRaw] = useQueryState("platform", "googleplay");
  const platform = platformRaw as Platform;
  const setPlatform = setPlatformRaw as (v: Platform) => void;
  const [apps, setApps] = useState<(AppRow & { latestReviewDate: string | null })[]>([]);
  const [selectedAppId, setSelectedAppIdRaw] = useQueryState("app", "");
  const setSelectedAppId = (v: string | undefined) => setSelectedAppIdRaw(v ?? "");
  const [timeRangeRaw, setTimeRangeRaw] = useQueryState("range", "week");
  const timeRange = timeRangeRaw as TimeRange;
  const setTimeRange = setTimeRangeRaw as (v: TimeRange) => void;
  const [locale, setLocaleRaw] = useQueryState("locale", "");
  const setLocale = (v: string | undefined) => setLocaleRaw(v ?? "");
  const [tagFilter] = useQueryState("tag", "");
  // 换主标签时子问题筛选要跟着清空——旧的子问题不一定属于新选的主标签。tag 和 subTag 必须在
  // 同一次 push 里改，不能各自调单参数 setter（否则后一次覆盖前一次，标签根本设不上去）
  const setTagFilter = (v: string | undefined) => setParams({ tag: v, subTag: "" });
  const [subTagFilter, setSubTagFilterRaw] = useQueryState("subTag", "");
  const setSubTagFilter = (v: string | undefined) => setSubTagFilterRaw(v ?? "");
  // "" = 全部，"true" = 只看已回复，"false" = 只看未回复
  const [repliedRaw, setRepliedRaw] = useQueryState("replied", "");
  const repliedFilter = repliedRaw === "true" ? true : repliedRaw === "false" ? false : undefined;
  const setRepliedFilter = (v: boolean | undefined) => setRepliedRaw(v === undefined ? "" : String(v));
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearchRaw] = useQueryState("q", "");
  const setSearch = (v: string) => setSearchRaw(v);
  const [pageRaw, setPageRaw] = useQueryState("page", "1", "replace");
  const page = Number(pageRaw) || 1;
  const setPage = (v: number) => setPageRaw(String(v));
  const [translateSettings, setTranslateSettings] = useState<TranslateSettings>({
    enabled: true,
    targetLang: "zh",
    scope: "non_target",
  });
  const [showTranslateSettings, setShowTranslateSettings] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [bootReady, setBootReady] = useState(false);

  const [stats, setStats] = useState<Stats | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  // "评分趋势/评分分布/地区满意度"是同一份评分数据的三种切面，合并成一张卡片用切换器选看哪个，
  // 不用三张卡片各占一块地方。选中具体地区后"地区满意度"这个切面本身没意义（已经聚焦到一个
  // 地区了），这时候要是还停在这个切面上，自动切回"趋势"，不能留着空切面晃在那
  const [ratingView, setRatingView] = useState<"trend" | "distribution" | "locale">("trend");
  useEffect(() => { if (locale && ratingView === "locale") setRatingView("trend"); }, [locale, ratingView]);

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const [selectedReview, setSelectedReview] = useState<ReviewRow | null>(null);
  const [aiReply, setAiReply] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatStopRequestedRef = useRef(false);
  const chatRequestStartedAtRef = useRef(0);
  const chatBusyRef = useRef(false);
  const composingRef = useRef(false);
  const translateMenuRef = useRef<HTMLDivElement>(null);
  const replyDetailRef = useRef<HTMLDivElement>(null);

  const selectedApp = apps.find((a) => a.id === selectedAppId);
  // 锚点用这个App真实数据里最新一条评论的日期，不用服务器当前时间——见 lib/reviews.ts
  // 的 getLatestReviewDate 注释，Google Play 评论接口本身有索引延迟，锚定"现在"会让窗口
  // 尾部总是空着一截，看起来像漏了数据。还没拿到任何App数据时（比如apps还没加载完）才退回当前时间。
  const since = useMemo(() => {
    const days = timeRange === "week" ? 7 : 30;
    const anchor = selectedApp?.latestReviewDate ? new Date(selectedApp.latestReviewDate) : new Date();
    return new Date(anchor.getTime() - days * 86400000).toISOString();
  }, [timeRange, selectedApp?.latestReviewDate]);
  const timeRangeLabel = timeRange === "week" ? "最近一周" : "最近一月";
  const appName = selectedApp?.display_name ?? "App";
  const askDraftStorageKey = `${ASK_DRAFT_STORAGE_PREFIX}:${selectedAppId || "no-app"}:${timeRange}:${locale || "all"}`;

  // ⌘B / Ctrl+B 切换左侧筛选栏——跟 VS Code、Claude 客户端的"切换侧边栏"快捷键保持一致，
  // Mac 浏览器 chrome 层占用的是 ⌘⇧B（书签栏），裸 ⌘B 是空的，页面可以放心拦截
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setLeftOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 拉 App 列表，默认选第一个
  useEffect(() => {
    fetch("/api/demo/apps").then((r) => r.json()).then((data) => {
      setApps(data.apps);
      if (data.apps.length && !selectedAppId) setSelectedAppId(data.apps[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 拉统计数据——selectedAppId 是从 URL 读的（刷新页面时立刻就有值），但 apps 列表（带着
  // since 计算要用的 latestReviewDate 锚点）是异步拉的，刷新时会有一瞬间 selectedAppId 已经
  // 有值但 apps 还没到，如果这时候就发请求，since 会先用错误的兜底值（当前时间）算一次，
  // 等 apps 到了再用正确锚点重新算一次——界面上的数字会先跳一次错的再跳回对的。等 apps 真的
  // 加载完（能找到对应 selectedApp）才发第一次请求，从源头避免这个问题，不是事后补救。
  useEffect(() => {
    if (!selectedAppId || !selectedApp) return;
    const params = new URLSearchParams();
    params.set("appId", selectedAppId);
    params.set("since", since);
    if (locale) params.set("locale", locale);
    fetch(`/api/demo/stats?${params}`).then((r) => r.json()).then(setStats);
  }, [selectedAppId, selectedApp, locale, since]);

  // "综合分析"面板"诉求占比"的"分析"由AI根据真实统计数字现场判断、现场生成，只在看这个面板时才拉，
  // 避免切换其他Tab时白白触发DeepSeek调用
  useEffect(() => {
    if (!selectedAppId || !selectedApp || activePanel !== "analysis") return;
    setInsights(null);
    setInsightsLoading(true);
    const params = new URLSearchParams();
    params.set("appId", selectedAppId);
    params.set("since", since);
    params.set("timeRangeLabel", timeRangeLabel);
    if (locale) params.set("locale", locale);
    fetch(`/api/demo/insights?${params}`)
      .then((r) => r.json())
      .then((data) => setInsights(data.error ? null : data))
      .finally(() => setInsightsLoading(false));
  }, [selectedAppId, selectedApp, locale, since, timeRangeLabel, activePanel]);

  // 拉评论列表（筛选/翻页变化时）
  useEffect(() => {
    if (!selectedAppId || !selectedApp) return;
    setLoading(true);
    const params = new URLSearchParams();
    params.set("appId", selectedAppId);
    params.set("since", since);
    if (locale) params.set("locale", locale);
    if (tagFilter) params.set("tag", tagFilter);
    if (tagFilter && subTagFilter) params.set("subTag", subTagFilter);
    if (search) params.set("q", search);
    if (repliedFilter !== undefined) params.set("replied", String(repliedFilter));
    params.set("page", String(page));
    params.set("pageSize", String(PAGE_SIZE));
    fetch(`/api/demo/reviews?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setReviews(data.items);
        setTotal(data.total);
      })
      .finally(() => setLoading(false));
  }, [selectedAppId, selectedApp, locale, tagFilter, subTagFilter, search, repliedFilter, page, since]);

  useEffect(() => {
    if (bootReady) return;
    if (!selectedAppId || !selectedApp) return;
    if (!stats) return;
    if (loading) return;
    const t = window.setTimeout(() => setBootReady(true), 220);
    return () => window.clearTimeout(t);
  }, [bootReady, selectedAppId, selectedApp, stats, loading]);

  const showDataLoading = !bootReady;

  // 切筛选条件时回到第一页（page 已经是 1 就不用再多触发一次 URL replace）
  useEffect(() => { if (page !== 1) setPage(1); }, [selectedAppId, locale, tagFilter, subTagFilter, search, repliedFilter, since]);

  useEffect(() => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  useEffect(() => {
    if (!showTranslateSettings) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (translateMenuRef.current && !translateMenuRef.current.contains(target)) {
        setShowTranslateSettings(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [showTranslateSettings]);

  useEffect(() => {
    if (!selectedReview) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (replyDetailRef.current && !replyDetailRef.current.contains(target)) {
        setSelectedReview(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [selectedReview]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(askDraftStorageKey);
      setChatInput(saved ?? "");
      requestAnimationFrame(() => autoGrowInput());
    } catch {
      // 本地存储不可用时忽略，不影响主流程
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askDraftStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(askDraftStorageKey, chatInput);
    } catch {
      // 本地存储不可用时忽略，不影响主流程
    }
  }, [askDraftStorageKey, chatInput]);

  function calcChatInputHeight(el: HTMLTextAreaElement) {
    const max = Math.min(Math.floor(window.innerHeight * 0.45), 420);
    el.style.height = "auto";
    const next = Math.max(48, Math.min(el.scrollHeight, max));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }

  function autoGrowInput(el?: HTMLTextAreaElement) {
    const target = el ?? chatInputRef.current;
    if (!target) return;
    calcChatInputHeight(target);
  }

  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    autoGrowInput(el);
  }, [activePanel]);

  async function streamAssistantAnswer(messageId: string, fullText: string) {
    let acc = "";
    for (const ch of fullText) {
      if (chatStopRequestedRef.current) break;
      acc += ch;
      setChatMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, a: acc } : m)));
      const ms = charDelay(ch);
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    }
  }

  function handleStopChat() {
    if (!chatBusyRef.current) return;
    const elapsed = Date.now() - chatRequestStartedAtRef.current;
    // 刚发送后留一个极短保护窗，避免用户双击发送键被误判为"停止"
    if (elapsed < 260) return;
    chatStopRequestedRef.current = true;
    chatAbortRef.current?.abort();
    chatBusyRef.current = false;
    setChatLoading(false);
  }

  // 真实调AI回答——把当前筛选范围内的真实统计数字喂给DeepSeek，不是预设话术匹配
  async function handleSendChat() {
    // 兼容同一帧内的二次点击：即使还没 re-render，也能立即走"停止"
    if (chatBusyRef.current) {
      handleStopChat();
      return;
    }
    const q = chatInput.trim();
    if (!q || !selectedAppId || chatLoading) return;
    chatStopRequestedRef.current = false;
    chatBusyRef.current = true;
    const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    chatAbortRef.current = controller;
    chatRequestStartedAtRef.current = Date.now();
    setChatMessages((prev) => [...prev, { id: msgId, q, a: "" }]);
    setChatInput("");
    if (chatInputRef.current) {
      chatInputRef.current.style.height = "48px";
      chatInputRef.current.style.overflowY = "hidden";
    }
    setChatLoading(true);
    try {
      const res = await fetch("/api/demo/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ question: q, appId: selectedAppId, locale, since, timeRangeLabel }),
      });
      const data = await res.json();
      const answer = data.error ? `回答失败：${data.error}` : data.answer;
      await streamAssistantAnswer(msgId, answer || "暂无回答");
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || chatStopRequestedRef.current) {
        return;
      }
      await streamAssistantAnswer(msgId, "请求失败，请重试。");
    } finally {
      chatAbortRef.current = null;
      chatBusyRef.current = false;
      setChatLoading(false);
    }
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

  // 跳转到某个标签（可带具体子问题）的评论列表时，保留当前已选的地区/时间范围筛选。
  // tag / subTag / panel 三个 URL 参数必须在同一次 push 里改完——之前分三次调 setter，
  // 互相覆盖，结果只有最后一个生效，标签压根没设上，所以点了没反应（这就是"点击进不去"的根因）。
  function jumpToTag(tag: string, subTag?: string) {
    setParams({ tag, subTag: subTag ?? "", panel: "reply" });
  }

  const rightPanelItems: { key: RightPanel; label: string; icon: React.ReactNode }[] = [
    { key: "complaints", label: "Top 反馈", icon: <ListOrdered size={15} /> },
    { key: "analysis", label: "综合分析", icon: <GitCompare size={14} /> },
    { key: "ask", label: "问 AI", icon: <Bot size={14} /> },
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
          <p className="text-white/75 text-[14px] mb-4">
            {timeRangeLabel}（{fmtDate(stats.dateRange.from)} ~ {fmtDate(stats.dateRange.to)}）共 {stats.total} 条公开评论，AI 按问题类型聚类（点标题看该类全部评论，点子问题直接看该子问题）：
          </p>
          <div className="flex flex-col gap-3">
            {Object.entries(stats.tagCounts)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([tag, t], i) => {
                const pct = (t.count / stats.total) * 100;
                // 整张卡不再是一个大 button——子问题要单独可点，button 不能嵌 button。
                // 圆环+标题行点了跳整个标签，子问题 chip 点了跳到那个具体子问题。
                return (
                  <div
                    key={tag}
                    onClick={() => jumpToTag(tag)}
                    className="border border-white/10 hover:bg-white/8 transition-colors rounded-xl p-4 flex items-center gap-4 cursor-pointer">
                    <div className="flex-none">
                      <DonutPercent percent={pct} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 text-left">
                        <span className="text-white/60 text-[14px] font-mono">#{i + 1}</span>
                        <span className="text-white/95 text-[17px] font-semibold">{t.label}（{t.count}）</span>
                      </div>
                      <TagBreakdown t={t} onJump={(subKey) => jumpToTag(tag, subKey)} />
                    </div>
                  </div>
                );
              })}
          </div>
          <p className="text-white/35 text-[12px] mt-4 leading-relaxed">
            数据来源：Google Play 公开评论抓取（非 {appName} 官方授权接入），AI 按真实评论内容分类，共 {totalTagCount} 次标签命中（一条评论可能命中多个类型）。
          </p>
        </div>
      )}

      {activePanel === "analysis" && stats && (() => {
        const sorted = Object.entries(stats.tagCounts).sort((a, b) => b[1].count - a[1].count);

        // 诉求占比的颜色：按排序后的序号循环取通用调色板，不跟具体 tag key 绑定
        const sliceColors = sorted.map((_, i) => CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]);

        // 评分分布：好评(4-5★)/差评(1-2★)/中评(3★)三段占比——只负责算数字给图表用，
        // "算不算两极分化"这个判断交给 /api/demo/insights 的AI，不在这里拍阈值
        const ratingTotal = Object.values(stats.ratingDist).reduce((a, b) => a + b, 0);
        const pctOf = (n: number) => (ratingTotal ? Math.round((n / ratingTotal) * 1000) / 10 : 0);

        // 每个标签的回复率——只负责算数字给柱状图用，"哪个算缺口"交给AI判断
        const replyByTag = sorted.map(([tag, t]) => ({
          tag, label: t.label, count: t.count,
          replyRate: t.count ? Math.round((t.repliedCount / t.count) * 1000) / 10 : 0,
        }));

        return (
          <div className="grid grid-cols-1 md:grid-cols-[1.15fr_1fr] gap-5 items-start">
            <div className="flex flex-col gap-3">
              <div className="bg-[#242c3d] rounded-3xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-white/95 text-[18px] font-bold">评分分析</p>
                  <div className={SEG_TRACK}>
                    {([
                      ["trend", "趋势", <LineChart key="i" size={13} />],
                      ["distribution", "分布", <BarChart2 key="i" size={13} />],
                      ...(!locale ? [["locale", "地区", <Globe key="i" size={13} />] as const] : []),
                    ] as const).map(([key, label, icon]) => (
                      <button key={key} onClick={() => setRatingView(key)}
                        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[13px] whitespace-nowrap transition-colors ${
                          ratingView === key ? `${SEG_PILL_ON} font-bold` : `${SEG_PILL_OFF} font-medium`
                        }`}>
                        {icon}{label}
                      </button>
                    ))}
                  </div>
                </div>

                {ratingView === "trend" && (
                  <>
                    <div className="flex items-baseline gap-3 mb-1">
                      <span className="text-[42px] font-bold text-white">{avgRating}</span>
                      <span className="text-white/68 text-[16px]">{timeRangeLabel}平均分</span>
                    </div>
                    <p className="text-white/60 text-[14px] mb-5">
                      {appName} · {fmtDate(stats.dateRange.from)} ~ {fmtDate(stats.dateRange.to)} · Google Play · 按真实评论日期统计每日均分（共 {stats.total} 条），点的大小代表当天评论量
                    </p>
                    <RatingTrendChart points={stats.dailyRatings} />
                  </>
                )}

                {ratingView === "distribution" && (
                  <>
                    <p className="text-white/75 text-[14px] mb-4">{timeRangeLabel} {ratingTotal} 条评论按星级分布：</p>
                    <div className="flex flex-col gap-1.5">
                      {[5, 4, 3, 2, 1].map((star) => {
                        const count = stats.ratingDist[star] ?? 0;
                        const pct = pctOf(count);
                        return (
                          <div key={star} className="flex items-center gap-3">
                            <span className="text-white/68 text-[13px] w-10 flex-none text-right">{star}★</span>
                            <div className="flex-1 h-2.5 bg-white/5 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: THEME_BLUE }} />
                            </div>
                            <span className="text-white/60 text-[12px] w-20 flex-none">{count} 条 · {pct}%</span>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {ratingView === "locale" && !locale && (
                  <>
                    <p className="text-white/75 text-[14px] mb-4">{timeRangeLabel}各地区真实均分，按评分从低到高排列（只列样本量够的地区）：</p>
                    {(() => {
                      // 样本量太小的地区算出来的均分没有统计意义，列出来反而误导——用 lib/reviews.ts 的
                      // meaningfulLocaleFloor（同一个门槛也用于喂给AI下结论），保证列表和AI结论永远一致。
                      const minSample = meaningfulLocaleFloor(allLocalesTotal);
                      const shown = stats.localeRatings.filter((l) => l.count >= minSample);
                      if (shown.length < 2) {
                        return <p className="text-white/40 text-[13px]">各地区样本量都偏小（不足 {minSample} 条），暂不做地区满意度对比。</p>;
                      }
                      return (
                        <div className="flex flex-col gap-1.5">
                          {shown.map((l) => (
                            <button key={l.locale} onClick={() => setLocale(l.locale === "unknown" ? undefined : l.locale)}
                              className="flex items-center gap-3 text-left rounded-lg px-2 py-1 hover:bg-white/8 transition-colors">
                              <span className="text-white/85 text-[13px] w-32 flex-none truncate">{localeLabel(l.locale)}</span>
                              <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                                <div className="h-full rounded-full" style={{ width: `${(l.avgRating / 5) * 100}%`, backgroundColor: THEME_BLUE }} />
                              </div>
                              <span className="text-white/60 text-[12px] w-24 flex-none">{l.avgRating}★ · {l.count} 条</span>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>

              <div className="bg-[#242c3d] rounded-3xl p-6">
                <p className="text-white/95 text-[18px] font-bold mb-3">官方回复覆盖率</p>
                <p className="text-white/75 text-[14px] mb-4">
                  整体回复率 {stats.officialReplyRate}%
                </p>
                <div className="flex flex-col gap-1.5">
                  {replyByTag.map((r) => (
                    <button key={r.tag} onClick={() => jumpToTag(r.tag)}
                      className="flex items-center gap-3 text-left rounded-lg px-2 py-1 hover:bg-white/8 transition-colors">
                      <span className="text-white/85 text-[13px] w-28 flex-none truncate">{r.label}</span>
                      <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${r.replyRate}%` }} />
                      </div>
                      <span className="text-white/60 text-[12px] w-28 flex-none">{r.count} 条 · 回复 {r.replyRate}%</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="md:col-start-2">
              <div className="bg-[#242c3d] rounded-3xl p-6">
                <p className="text-white/95 text-[18px] font-bold mb-4">诉求占比</p>
                <p className="text-white/75 text-[14px] mb-4">
                  真实数据画像：按 AI 分类命中量统计{timeRangeLabel}整体构成，点击任意一块跳转查看该类全部真实评论：
                </p>
                <div className="flex items-center gap-6 flex-wrap">
                  <PieBreakdown
                    slices={sorted.map(([tag, t], i) => ({ key: tag, count: t.count, color: sliceColors[i] }))}
                    hoveredKey={hoveredTag} onHoverKey={setHoveredTag} />
                  <div className="flex-1 min-w-[220px] flex flex-col gap-1.5">
                    {sorted.map(([tag, t], i) => {
                      const pct = stats.total ? Math.round((t.count / stats.total) * 1000) / 10 : 0;
                      return (
                        <button key={tag} onClick={() => jumpToTag(tag)}
                          onMouseEnter={() => setHoveredTag(tag)} onMouseLeave={() => setHoveredTag(null)}
                          className={`flex items-center gap-2 text-left rounded-lg px-2 py-1.5 transition-colors ${
                            hoveredTag === tag ? "bg-white/10" : "hover:bg-white/8"
                          }`}>
                          <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ backgroundColor: sliceColors[i] }} />
                          <span className="text-white/85 text-[13px] flex-1 min-w-0 truncate">{t.label}</span>
                          <span className="text-white/60 text-[12px] flex-none">{t.count} 条 · {pct}%</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
                {insightsLoading && <InsightsLoading />}
                {insights?.complaintsVsFeatureRequest && (
                  <div className="bg-emerald-900/35 rounded-xl p-4 mt-4">
                    <p className="text-emerald-400 text-[14px] font-semibold mb-1">分析</p>
                    <p className="text-white/80 text-[14px] leading-relaxed">{insights.complaintsVsFeatureRequest}</p>
                  </div>
                )}
              </div>
            </div>

          </div>
        );
      })()}
    </div>
  );

  // ── 中间区域：问 AI ──
  const AskResult = (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div ref={chatViewportRef} className="flex-1 overflow-y-auto px-6 py-6">
        {chatMessages.length === 0 && !chatLoading ? (
          <div className="max-w-3xl mx-auto text-white/60 text-[17px] leading-relaxed">
            <p className="font-medium text-white/80">问我关于这款 App {timeRangeLabel}的评论的任何问题</p>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto w-full flex flex-col gap-5">
            {chatMessages.map((m, i) => (
              <div key={m.id} className="space-y-2.5">
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl bg-[#4b5f9f] text-white px-4 py-3 text-[17px] leading-relaxed shadow-[0_8px_24px_rgba(87,129,216,0.25)]">
                    {m.q}
                  </div>
                </div>
                <div className="flex justify-start">
                  <div className="max-w-[90%] rounded-2xl border border-white/15 bg-[#242c3d] px-4 py-3 text-[17px] text-white leading-relaxed">
                    <MarkdownMessage content={m.a || (chatLoading && i === chatMessages.length - 1 ? "正在组织回答…" : "")} />
                  </div>
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex items-center gap-2 text-white/45 text-[14px] pl-1">
                <Loader2 size={14} className="animate-spin" />AI 正在查阅真实评论数据…
              </div>
            )}
          </div>
        )}
      </div>
      <div className="px-4 pb-5 pt-3 flex-none">
        <div className="max-w-4xl mx-auto flex gap-3 items-end rounded-3xl border border-white/12 bg-white/[0.06] backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.45)] px-3.5 py-3">
          <textarea
            ref={chatInputRef}
            value={chatInput}
            rows={1}
            placeholder=""
            onChange={(e) => {
              setChatInput(e.target.value);
            }}
            onInput={(e) => autoGrowInput(e.currentTarget)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(e) => {
              if (chatBusyRef.current) {
                return;
              }
              if (e.key === "Enter" && (e.nativeEvent as KeyboardEvent).isComposing) {
                return;
              }
              if (e.key === "Enter" && composingRef.current) {
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendChat();
              }
            }}
            style={{ height: "48px" }}
            className="flex-1 resize-none min-h-12 bg-transparent border-0 rounded-2xl px-3.5 py-3 text-[17px] leading-relaxed text-white placeholder-white/30 outline-none transition-colors overflow-y-hidden"
          />
          <button
            type="button"
            onClick={chatLoading ? handleStopChat : handleSendChat}
            disabled={!chatLoading && !chatInput.trim()}
            aria-label={chatLoading ? "停止" : "发送"}
            className="flex-none h-11 min-w-11 rounded-2xl px-3 flex items-center justify-center transition-colors disabled:cursor-not-allowed bg-[#e6ecff] text-[#20325f] hover:bg-[#f0f4ff] disabled:bg-[#e6ecff]/30 disabled:text-white/35">
            {chatLoading ? <X size={16} /> : <ArrowUp size={19} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  );

  // ── 中间区域：回复模式 ──
  const ReplyResult = (
    <div className="flex-1 flex flex-col overflow-hidden">
      {tagFilter && stats?.tagCounts[tagFilter] && (
        <div className="flex items-center gap-4 px-4 pt-4 flex-none">
          <DonutPercent percent={(stats.tagCounts[tagFilter].count / stats.total) * 100} size={48} />
          <div className="min-w-0">
            <p className="text-white/90 text-[15px] font-medium mb-1">{stats.tagCounts[tagFilter].label}（{stats.tagCounts[tagFilter].count}）</p>
            {/* 点子问题 chip 直接把列表筛到那个子问题；已选中的高亮，再点一下取消（回到整个标签） */}
            <TagBreakdown t={stats.tagCounts[tagFilter]} activeSubKey={subTagFilter || undefined}
              onJump={(subKey) => setSubTagFilter(subKey === subTagFilter ? undefined : subKey)} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-2 flex-none">
        <div className="relative flex-1 min-w-[160px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
            placeholder="搜索评论内容/作者..."
            className="w-full bg-[#242c3d] border border-white/20 rounded-lg pl-8 pr-3 py-1.5 text-[13px] text-white placeholder-white/35 outline-none focus:border-white/45" />
        </div>
        <select value={tagFilter || ""} onChange={(e) => setTagFilter(e.target.value || undefined)}
          className="bg-[#242c3d] border border-white/20 rounded-lg px-2.5 py-1.5 text-[12px] text-white/90 outline-none focus:border-white/45">
          <option value="">全部问题类型</option>
          {stats && Object.entries(stats.tagCounts).sort((a, b) => b[1].count - a[1].count).map(([key, t]) => (
            <option key={key} value={key}>{t.label}（{t.count}）</option>
          ))}
        </select>
        {tagFilter && stats?.tagCounts[tagFilter] && Object.keys(stats.tagCounts[tagFilter].subTags).length > 0 && (
          <select value={subTagFilter || ""} onChange={(e) => setSubTagFilter(e.target.value || undefined)}
            className="bg-[#242c3d] border border-white/20 rounded-lg px-2.5 py-1.5 text-[12px] text-white/90 outline-none focus:border-white/45">
            <option value="">全部子问题</option>
            {Object.entries(stats.tagCounts[tagFilter].subTags).sort((a, b) => b[1].count - a[1].count).map(([key, s]) => (
              <option key={key} value={key}>{s.label}（{s.count}）</option>
            ))}
          </select>
        )}
        <select value={repliedFilter === undefined ? "" : String(repliedFilter)}
          onChange={(e) => setRepliedFilter(e.target.value === "" ? undefined : e.target.value === "true")}
          className="bg-[#242c3d] border border-white/20 rounded-lg px-2.5 py-1.5 text-[12px] text-white/90 outline-none focus:border-white/45">
          <option value="">全部回复状态</option>
          <option value="true">已回复</option>
          <option value="false">未回复</option>
        </select>
        {search && (
          <button onClick={() => { setSearch(""); setSearchInput(""); }}
            className="flex items-center gap-1 px-3 py-1 rounded-full text-[12px] bg-white/15 text-white/90">
            "{search}" <X size={11} />
          </button>
        )}
        <div className="relative" ref={translateMenuRef}>
          <button onClick={() => setShowTranslateSettings((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
              translateSettings.enabled ? "bg-white/12 text-white/80" : "bg-white/6 text-white/60"
            }`}>
            <Settings size={12} />翻译
          </button>
          {showTranslateSettings && (
            <div className="absolute right-0 top-full mt-1.5 z-10 w-56 bg-[#242c3d] border border-white/20 rounded-xl p-3 shadow-xl flex flex-col gap-3">
              <label className="flex items-center justify-between text-[13px] text-white/80">
                启用翻译
                <input type="checkbox" checked={translateSettings.enabled}
                  onChange={(e) => setTranslateSettings((s) => ({ ...s, enabled: e.target.checked }))} />
              </label>
              <div>
                <p className="text-white/45 text-[11px] uppercase tracking-wider mb-1.5">目标语言</p>
                {([["zh", "中文"], ["en", "英文"]] as const).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-2 text-[13px] text-white/80 py-0.5">
                    <input type="radio" checked={translateSettings.targetLang === v}
                      onChange={() => setTranslateSettings((s) => ({ ...s, targetLang: v }))} />
                    {label}
                  </label>
                ))}
              </div>
              <div>
                <p className="text-white/45 text-[11px] uppercase tracking-wider mb-1.5">翻译范围</p>
                {([
                  ["non_target", "翻译所有非目标语言"],
                  ["non_zh_en", "只翻译非中英文（保留英文原文）"],
                ] as const).map(([v, label]) => (
                  <label key={v} className="flex items-center gap-2 text-[13px] text-white/80 py-0.5">
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
                    isSelected ? "ring-1 ring-white/25 bg-white/12" : "border border-white/10 hover:bg-white/8"
                  }`}>
                  <div className="flex items-center justify-between mb-2">
                    <Stars rating={r.rating ?? 0} />
                    <div className="flex items-center gap-1.5">
                      <span className="text-white/60 text-[11px]">{localeLabel(r.locale)}</span>
                      {r.app_version && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded font-mono bg-[#383838] text-white/68">{r.app_version}</span>
                      )}
                    </div>
                  </div>
                  <p className={`text-white/80 text-[14px] leading-relaxed mb-1 ${isExpanded ? "" : "line-clamp-3"}`}>{display.text}</p>
                  {mayBeTruncated && (
                    <span onClick={(e) => toggleExpand(r.id, e)}
                      className="text-white/45 hover:text-white/60 text-[12px] mb-1 inline-block transition-colors">
                      {isExpanded ? "收起" : "展开全文"}
                    </span>
                  )}
                  {display.translated && <p className="text-white/35 text-[11px] mb-2">已自动翻译</p>}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-white/60 text-[11px]">{r.author} · {fmtDate(r.review_date)}</span>
                    {r.official_reply && <span className="text-white/45 text-[11px]">有官方回复</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {!loading && total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-3 mt-4 text-[13px] text-white/68">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1 rounded-lg bg-white/8 disabled:opacity-30">上一页</button>
            <span>第 {page} / {Math.ceil(total / PAGE_SIZE)} 页 · 共 {total} 条</span>
            <button disabled={page >= Math.ceil(total / PAGE_SIZE)} onClick={() => setPage(page + 1)} className="px-3 py-1 rounded-lg bg-white/8 disabled:opacity-30">下一页</button>
          </div>
        )}
      </div>

      {/* 回复详情 / AI 回复 */}
      <div ref={replyDetailRef} className="bg-white/4 p-4">
        {selectedReview ? (
          <div className="flex flex-col gap-2">
            {(() => {
              const display = getDisplayContent(selectedReview, translateSettings);
              return (
                <div className="bg-white/5 rounded-lg px-3 py-2">
                  <p className="text-white/60 text-[12px] mb-0.5">评论原文</p>
                  <p className="text-white/80 text-[13px] leading-relaxed whitespace-pre-line max-h-32 overflow-y-auto">
                    {selectedReview.content}
                  </p>
                  {display.translated && (
                    <>
                      <p className="text-white/60 text-[12px] mt-2 mb-0.5">译文</p>
                      <p className="text-white/80 text-[13px] leading-relaxed whitespace-pre-line max-h-32 overflow-y-auto">
                        {display.text}
                      </p>
                    </>
                  )}
                </div>
              );
            })()}
            {selectedReview.official_reply && (
              <div className="bg-white/5 rounded-lg px-3 py-2">
                <p className="text-white/50 text-[12px] font-medium mb-0.5">{appName} 官方曾这样回复（公开信息，模板化覆盖海量评论）</p>
                <p className="text-white/68 text-[13px] leading-relaxed line-clamp-2">{selectedReview.official_reply}</p>
              </div>
            )}
            <div className="bg-white/8 rounded-lg px-3 py-2">
              <div className="flex items-start justify-between gap-2 mb-1">
                <p className="text-white/80 text-[13px] font-medium">呼声雷达 AI 针对这条的个性化回复建议</p>
                <button onClick={() => setSelectedReview(null)} className="text-white/20 hover:text-white/75 transition-colors"><X size={14} /></button>
              </div>
              {aiReply ? (
                <p className="text-white/85 text-[14px] leading-relaxed whitespace-pre-line">{aiReply}</p>
              ) : (
                <button onClick={handleGenerateAiReply} disabled={aiLoading}
                  className="flex items-center gap-1.5 text-[13px] text-white/80 bg-white/10 hover:bg-white/15 disabled:opacity-50 px-3 py-1.5 rounded-lg transition-colors">
                  {aiLoading && <Loader2 size={12} className="animate-spin" />}
                  {aiLoading ? "生成中..." : "生成 AI 回复建议"}
                </button>
              )}
              {aiError && <p className="text-red-400 text-[12px] mt-1.5">{aiError}</p>}
            </div>
          </div>
        ) : (
          <p className="text-white/35 text-[14px] px-1">点击评论卡片，查看 AI 回复建议</p>
        )}
      </div>
    </div>
  );

  // ── 左栏 ──
  // 外层宽度做动画（48↔208，只动 width 一个属性），内层按 leftOpen 整体切换分支——
  // 收起那支永远只有一个图标按钮，结构上不可能露出别的内容；展开那支固定 w-52，
  // 跟外层当前宽度无关，所以外层变宽的过程中它不会被压着重新换行
  // 不做成悬浮卡片——左栏直接用自己的底色铺满整列，跟右栏之间不留缝、不加分割线，
  // 单靠色块深浅区分两栏，贴近一般 LLM 网页版（ChatGPT/Claude）的平铺式布局
  const LeftPanel = (
    <div className={`flex-none flex flex-col overflow-hidden bg-[#1d2433] transition-[width] duration-200 ease-in-out ${leftOpen ? "w-52" : "w-12"}`}>
      {!leftOpen ? (
        <div className="p-3 flex-none">
          <button onClick={() => setLeftOpen(true)}
            className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition-colors">
            <PanelLeft size={20} strokeWidth={1.5} />
          </button>
        </div>
      ) : (
      <div className="flex flex-col overflow-hidden flex-1 w-52">
        {/* 跟收起状态用一样的 p-3，图标在两种状态下像素对齐，切换时看起来"原地"不挪 */}
        <div className="p-3 flex items-center justify-between flex-none">
          <button onClick={() => setLeftOpen(false)}
            className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition-colors flex-none">
            <PanelLeft size={20} strokeWidth={1.5} />
          </button>
          <span className="text-white/80 text-[13px] font-semibold whitespace-nowrap">筛选</span>
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="py-2 flex items-center justify-center gap-3">
            <button onClick={() => setPlatform("googleplay")}
              className={`p-2.5 rounded-xl transition-all ${platform === "googleplay" ? "bg-white/12 ring-1 ring-white/20" : "hover:bg-white/10"}`}>
              <img src="/Google_Play_2022_icon.svg.png" alt="Google Play" className="w-7 h-7" />
            </button>
            <button onClick={() => setPlatform("appstore")} title="暂无数据"
              className={`p-2.5 rounded-xl transition-all relative ${platform === "appstore" ? "bg-white/12 ring-1 ring-white/20" : "hover:bg-white/10"}`}>
              <img src="/App_Store_(iOS).svg.png" alt="App Store" className="w-7 h-7 opacity-40" />
            </button>
          </div>
          <div className="py-2 px-3 relative">
            <button onClick={() => setShowAppMenu((v) => !v)}
              className="w-full flex items-center justify-between gap-2 bg-white/8 hover:bg-white/12 transition-colors rounded-lg px-3 py-2 text-[15px] font-semibold text-white/90">
              <span className="truncate">{selectedApp?.display_name ?? "选择 App"}</span>
              <ChevronDown size={15} className={`flex-none text-white/60 transition-transform ${showAppMenu ? "rotate-180" : ""}`} />
            </button>
            {showAppMenu && (
              <div className="absolute left-3 right-3 top-full mt-1.5 z-10 bg-[#242c3d] border border-white/20 rounded-xl p-1.5 shadow-xl flex flex-col gap-0.5">
                {apps.map((a) => (
                  <button key={a.id} onClick={() => { setParams({ app: a.id, locale: "", tag: "", subTag: "" }); setShowAppMenu(false); }}
                    className={`text-left px-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
                      a.id === selectedAppId ? "bg-white/12 text-white/90" : "text-white/80 hover:bg-white/8"
                    }`}>
                    {a.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="py-2 px-3 flex items-center justify-center">
            <div className={SEG_TRACK}>
              {(["week", "month"] as TimeRange[]).map((t) => (
                <button key={t} onClick={() => setTimeRange(t)}
                  className={`px-3.5 py-1.5 rounded-full text-[14px] transition-colors ${timeRange === t ? `${SEG_PILL_ON} font-bold` : `${SEG_PILL_OFF} font-medium`}`}>
                  {t === "week" ? "最近一周" : "最近一月"}
                </button>
              ))}
            </div>
          </div>
          {platform === "googleplay" ? (
            <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-1 text-[14px]">
              <p className="text-white/60 uppercase tracking-wider text-[13px] font-semibold mb-1.5 px-1 flex items-center gap-1.5">
                语言/地区批次
                <InfoTooltip text="此为 Google Play 官方分类方式，不代表评论的真实语言或所在地区" size={14} />
              </p>
              <button onClick={() => setLocale(undefined)}
                className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg transition-colors ${!locale ? "bg-white/12 text-white/80" : "text-white/68 hover:text-white/80 hover:bg-white/10"}`}>
                <Globe size={12} /><span>全部 {stats ? `(${allLocalesTotal})` : ""}</span>
              </button>
              {stats && Object.entries(stats.localeCounts).sort((a, b) => b[1] - a[1]).map(([l, count]) => (
                <button key={l} onClick={() => setLocale(l)}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg transition-colors ${locale === l ? "bg-white/12 text-white/80" : "text-white/68 hover:text-white/80 hover:bg-white/10"}`}>
                  <Globe size={12} /><span>{localeLabel(l)} ({count})</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center px-3">
              <p className="text-white/35 text-[12px] text-center leading-relaxed">App Store 这次没有抓取公开评论数据，暂不支持筛选</p>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );

  // ── 中栏 ──（跟左栏一样不做卡片，直接铺底色，靠跟左栏不同的色块区分）
  const CenterPanel = (
    <div className="flex-1 flex flex-col overflow-hidden min-w-0 bg-[#141a27]">
      <div className="px-3 py-2.5 bg-white/4 flex items-center justify-between flex-none gap-3">
        <div className="flex items-center gap-8 min-w-0">
          {/* 常驻 logo：不管左栏开合都看得到，不用跟着侧栏一起消失 */}
          <div className="flex items-center gap-1.5 flex-none">
            <Link href="/demo" className="text-2xl tracking-tight text-white whitespace-nowrap"
              style={{ fontFamily: "'smiley-sans', sans-serif" }}>
              呼声雷达
            </Link>
            <InfoTooltip text="声明：本页为产品演示（Demo），与所展示评论所属的 App 官方无任何关联；评论数据均为应用商店公开可见内容" size={14} />
          </div>
          <div className={`${SEG_TRACK} overflow-x-auto`}>
            {rightPanelItems.map((item) => (
              <button key={item.key} onClick={() => setActivePanel(item.key)}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[14px] whitespace-nowrap transition-colors ${
                  activePanel === item.key ? SEG_PILL_ON : SEG_PILL_OFF
                }`}>
                {item.icon}
                <span className={activePanel === item.key ? "font-bold" : "font-medium"}>{item.label}</span>
              </button>
            ))}
          </div>
        </div>
        <span className="text-white/45 text-[13px] flex-none">{stats ? `${stats.total} 条评论` : "加载中..."}</span>
      </div>

      {showDataLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-[pulse_1.2s_ease-in-out_infinite]" />
              <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-[pulse_1.2s_ease-in-out_200ms_infinite]" />
              <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-[pulse_1.2s_ease-in-out_400ms_infinite]" />
            </div>
            <p className="mt-3 text-white/45 text-[13px] tracking-wide">评论数据加载中</p>
          </div>
        </div>
      ) : (
        activePanel === "reply" ? ReplyResult : activePanel === "ask" ? AskResult : AnalyzeResult
      )}
    </div>
  );

  return (
    <div className="h-screen flex flex-col font-[family-name:var(--font-geist)] overflow-hidden">
      <div className="hidden md:flex flex-1 overflow-hidden">
        {LeftPanel}
        {CenterPanel}
      </div>

      <div className="flex md:hidden flex-1 flex-col overflow-hidden items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <h1 className="text-2xl font-bold text-white mb-3">呼声雷达 Demo</h1>
          <p className="text-white/65 leading-relaxed">
            请在电脑端浏览器访问，移动端 Demo 暂未适配。
          </p>
        </div>
      </div>
    </div>
  );
}
