"use client";

import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Globe,
  ListOrdered, GitCompare, Bot, Reply,
  X, BarChart2, LineChart, PanelLeft, Search, Loader2, Settings, ChevronDown, Info, ArrowUp, Trash2, Smile, Plus, RefreshCw, ListChecks, Mail,
} from "lucide-react";
import { type ReviewRow, type AppRow, type TerminologyEntry } from "@/lib/supabase";
import { meaningfulLocaleFloor, sortSubTagRecordForDisplay } from "@/lib/analysisShared";
import { hasSubTagBreakdown } from "@/lib/promptKit.mjs";
import { DEFAULT_DEMO_TIME_RANGE, resolveDefaultDemoApp } from "@/lib/demoDefaults";
import { useQueryState, useQueryParams } from "@/lib/useQueryState";
import { RECLASSIFY_MAX, ASK_SUMMARIZE_MAX } from "@/lib/reviews";

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
  /** 当前时间窗口内评论条数（不含 locale 筛选；与「全部」侧栏同口径） */
  windowReviewTotal: number;
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

type ReplyStatusCounts = {
  total: number;
  replied: number;
  unreplied: number;
};

type TranslateSettings = {
  enabled: boolean;
  targetLang: TargetLang;
  scope: TranslateScope;
};

type AskSettings = {
  useEmoji: boolean;
  useThinking: boolean;
};

type AiReplySettings = {
  tone: string;
  style: string;
  contactInfo: string;
};

type LeftSidebarView = "filter" | "settings";
type RatingView = "trend" | "distribution" | "locale";

const RIGHT_PANEL_NAV: { key: RightPanel; label: string }[] = [
  { key: "complaints", label: "Top 反馈" },
  { key: "analysis", label: "综合分析" },
  { key: "ask", label: "问 AI" },
  { key: "reply", label: "评论查看&回复" },
];

const PANEL_ICONS: Record<RightPanel, React.ReactNode> = {
  complaints: <ListOrdered size={15} />,
  analysis: <GitCompare size={14} />,
  ask: <Bot size={14} />,
  reply: <Reply size={14} />,
};

const PAGE_SIZE = 200;
const ASK_DRAFT_STORAGE_PREFIX = "hushengradar.askDraft.v1";
const ASK_CHAT_STORAGE_PREFIX = "hushengradar.askChat.v1";
const TRANSLATE_SETTINGS_KEY = "hushengradar.translateSettings.v1";
const ASK_SETTINGS_KEY = "hushengradar.askSettings.v1";

function askContextStorageKey(prefix: string, appId: string, timeRange: TimeRange, locale: string) {
  return `${prefix}:${appId || "no-app"}:${timeRange}:${locale || "all"}`;
}

const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  enabled: true,
  targetLang: "zh",
  scope: "non_target",
};

const DEFAULT_ASK_SETTINGS: AskSettings = {
  useEmoji: true,
  useThinking: false,
};

const DEFAULT_AI_REPLY_SETTINGS: AiReplySettings = {
  tone: "口语化、像真人而非客服模板。按评论类型调整基调：投诉/差评——先表达理解或致歉（如确有问题），再说明，不过度承诺，多用「已收到问题」「已转达开发团队」「已转达设计团队」；好评——真诚感谢、不要致歉、无需附联系方式；功能请求——感谢建议并说明「已转达产品团队评估」，不承诺一定实现。遇崩溃/闪退/卡顿等 bug，请用户补充设备型号、系统与游戏版本、复现步骤或截图，便于跟进。",
  style: "不要千篇一律、不要客服腔模板，自然简洁。长度控制在 2~4 句、约 40~120 字，差评也不要堆砌道歉。默认不主动使用 emoji；仅在回复好评等轻松场景最多用 1 个，投诉、退款、账号、扣费、严重 bug 等场景一律不用。",
  contactInfo: "涉及退款需求：refund@yourapp.com；涉及账号（丢失/封号/申诉）、充值未到账、扣费/乱扣费、严重 bug 等需核实订单或身份的问题：support@yourapp.com；其余普通问题不要附加任何联系方式。（占位邮箱，请替换为团队真实邮箱）",
};

function loadJsonSetting<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function saveJsonSetting(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota / private mode
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("[contenteditable='true']"));
}

function ShortcutRow({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-white/75">
      <span className="min-w-0 leading-snug">{desc}</span>
      <span className="flex items-center gap-1 flex-none">
        {keys.map((k) => (
          <kbd key={k} className="min-w-[1.35rem] text-center px-1.5 py-0.5 rounded bg-[#1d2433] border border-white/12 text-[11px] text-white/70 font-mono">
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}

const GLASS_TOOLTIP_CLASS =
  "pointer-events-none z-[100] rounded-xl border border-white/18 bg-white/[0.14] px-3 py-2 text-[13px] text-white/88 leading-snug shadow-[0_8px_28px_rgba(0,0,0,0.35)] backdrop-blur-xl";

const LOCKED_FEATURE_HINT = "暂时不可自定义哦，敬请期待";
const LOCKED_UNAVAILABLE_HINT = "暂时不可用，敬请期待";
const LOCKED_SURFACE_CURSOR = "cursor-not-allowed";

type GlassTooltipPlacement = "bottom-end" | "bottom-start" | "bottom-center" | "top-center" | "right";

function glassTooltipStyle(placement: GlassTooltipPlacement, rect: DOMRect): React.CSSProperties {
  const gap = 8;
  switch (placement) {
    case "bottom-end":
      return { top: rect.bottom + gap, left: rect.right, transform: "translateX(-100%)" };
    case "bottom-start":
      return { top: rect.bottom + gap, left: rect.left };
    case "bottom-center":
      return { top: rect.bottom + gap, left: rect.left + rect.width / 2, transform: "translateX(-50%)" };
    case "top-center":
      return { top: rect.top - gap, left: rect.left + rect.width / 2, transform: "translate(-50%, -100%)" };
    case "right":
      return { top: rect.top, left: rect.right + gap, maxWidth: "11.5rem" };
  }
}

function GlassHoverTooltip({
  message,
  children,
  className = "",
  placement = "bottom-end",
  wrapClassName = "relative flex-none",
}: {
  message: string;
  children: React.ReactNode;
  className?: string;
  placement?: GlassTooltipPlacement;
  wrapClassName?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({});

  const reveal = () => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setTooltipStyle(glassTooltipStyle(placement, rect));
    setShow(true);
  };

  return (
    <div
      ref={wrapRef}
      className={wrapClassName}
      onMouseEnter={reveal}
      onMouseLeave={() => setShow(false)}
      onFocus={reveal}
      onBlur={() => setShow(false)}>
      {children}
      {show && typeof document !== "undefined" && createPortal(
        <div role="tooltip" className={`fixed ${GLASS_TOOLTIP_CLASS} ${className}`} style={tooltipStyle}>
          {message}
        </div>,
        document.body,
      )}
    </div>
  );
}

const AI_REPLY_FIELD_CLASS =
  "w-full bg-[#1d2433] border border-white/15 rounded-lg px-2.5 py-2 text-[13px] text-white/85 placeholder-white/35 outline-none resize-none cursor-pointer hover:border-white/25 focus:border-white/30";

const AI_REPLY_FIELD_LOCKED_CLASS =
  `${AI_REPLY_FIELD_CLASS} cursor-not-allowed`;

const TERMINOLOGY_INPUT_CLASS =
  "w-full min-w-0 bg-[#1d2433] border border-white/15 rounded-lg px-2 py-1.5 text-[12px] text-white/85 placeholder-white/35 outline-none focus:border-white/30";

const TERMINOLOGY_INPUT_LOCKED_CLASS =
  `${TERMINOLOGY_INPUT_CLASS} cursor-not-allowed hover:border-white/25 focus:border-white/30`;

function emptyTerminologyRow(): TerminologyEntry {
  return { source: "", zh: "", en: "", note: "" };
}

function TerminologyGlossaryEditor({
  appId,
  appName,
  rows,
  onChange,
  onSaved,
  locked = false,
}: {
  appId: string | undefined;
  appName: string;
  rows: TerminologyEntry[];
  onChange: (rows: TerminologyEntry[]) => void;
  onSaved: (glossary: TerminologyEntry[]) => void;
  locked?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const updateRow = (index: number, patch: Partial<TerminologyEntry>) => {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setMsg(null);
  };

  const addRow = () => onChange([...rows, emptyTerminologyRow()]);
  const removeRow = (index: number) => onChange(rows.filter((_, i) => i !== index));

  const save = async () => {
    if (!appId) return;
    setSaving(true);
    setMsg(null);
    try {
      const payload = rows
        .map((r) => ({
          source: r.source?.trim() ?? "",
          zh: r.zh?.trim() || null,
          en: r.en?.trim() || null,
          note: r.note?.trim() || null,
        }))
        .filter((r) => r.source);
      const res = await fetch(`/api/demo/apps/${appId}/terminology`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ glossary: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      onSaved(data.glossary ?? []);
      setMsg("已保存");
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative bg-white/6 rounded-xl p-3 flex flex-col gap-3">
      <div className={locked ? "pointer-events-none select-none" : undefined}>
      {rows.length === 0 ? (
        <p className="text-white/40 text-[12px] leading-relaxed px-0.5">
          暂无术语条目。添加后对本 App 的翻译、问 AI、回复建议均生效。
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[1fr_1fr_1fr_0.8fr_28px] gap-1.5 text-[11px] text-white/45 px-0.5">
            <span>原文/专名</span>
            <span>中文</span>
            <span>英文</span>
            <span>备注</span>
            <span />
          </div>
          {rows.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_1fr_0.8fr_28px] gap-1.5 items-center">
              {(["source", "zh", "en", "note"] as const).map((field) => (
                <input
                  key={field}
                  type="text"
                  readOnly={locked}
                  tabIndex={locked ? -1 : undefined}
                  value={row[field] ?? ""}
                  placeholder={field === "source" ? "Honor of Kings" : field === "zh" ? "王者荣耀" : field === "en" ? "Honor of Kings" : "可选"}
                  onChange={(e) => updateRow(i, { [field]: e.target.value })}
                  className={locked ? TERMINOLOGY_INPUT_LOCKED_CLASS : TERMINOLOGY_INPUT_CLASS}
                />
              ))}
              <button
                type="button"
                disabled={locked}
                tabIndex={locked ? -1 : undefined}
                onClick={() => removeRow(i)}
                className="flex items-center justify-center h-8 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/8 disabled:opacity-40"
                aria-label="删除此行">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          disabled={locked || !appId}
          tabIndex={locked ? -1 : undefined}
          onClick={addRow}
          className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-2.5 py-1.5 text-[12px] text-white/75 hover:bg-white/8 disabled:opacity-40">
          <Plus size={13} />
          添加条目
        </button>
        <button
          type="button"
          disabled={locked || !appId || saving}
          tabIndex={locked ? -1 : undefined}
          onClick={save}
          className="inline-flex items-center gap-1 rounded-lg bg-white/12 px-2.5 py-1.5 text-[12px] text-white/85 hover:bg-white/18 disabled:opacity-40">
          {saving ? <Loader2 size={13} className="animate-spin" /> : null}
          保存到 {appName}
        </button>
        {msg && <span className={`text-[12px] ${msg === "已保存" ? "text-emerald-400/90" : "text-red-400/90"}`}>{msg}</span>}
      </div>
      </div>
      {locked && (
        <div
          className={`absolute inset-0 z-10 ${LOCKED_SURFACE_CURSOR} rounded-xl bg-transparent`}
          aria-hidden
        />
      )}
    </div>
  );
}

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

function AskThinkingToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      aria-label="切换 thinking 模式"
      className={`flex-none h-[52px] rounded-2xl px-4 text-[16px] font-bold tracking-[0.02em] transition-colors select-none flex items-center justify-center ${
        enabled
          ? "border border-[#5781d8]/50 bg-[#5781d8]/22 text-[#a8c4ff] shadow-[0_0_20px_rgba(87,129,216,0.18)]"
          : "border border-white/10 bg-white/[0.04] text-white/30 hover:text-white/45 hover:border-white/16 hover:bg-white/[0.07]"
      }`}>
      thinking
    </button>
  );
}

function AskEmojiToggle({ enabled, onChange, compact = false }: { enabled: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  return (
    <GlassHoverTooltip
      message="设置AI回复里是否含emoji"
      placement="top-center"
      wrapClassName="inline-flex flex-none"
      className="whitespace-nowrap">
      <button
        type="button"
        onClick={() => onChange(!enabled)}
        aria-pressed={enabled}
        aria-label="设置 AI 回复是否含 Emoji"
        className={`flex items-center rounded-xl border transition-colors ${
          compact ? "gap-2 px-2 py-1.5 text-[14px]" : "gap-2.5 px-3 py-2 text-[14px]"
        } ${
          enabled
            ? "border-[#5781d8]/45 bg-[#5781d8]/18 text-white"
            : "border-white/12 bg-white/[0.06] text-white/55 hover:border-white/20 hover:bg-white/[0.09]"
        }`}>
        <Smile size={compact ? 14 : 15} className={enabled ? "text-[#8fb0ff]" : "text-white/35"} strokeWidth={enabled ? 2.2 : 1.8} />
        {!compact && <span className="font-medium">Emoji</span>}
        <span
          aria-hidden
          className={`relative inline-flex h-[18px] w-8 flex-none rounded-full transition-colors ${
            enabled ? "bg-[#5781d8]" : "bg-white/18"
          }`}>
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform ${
              enabled ? "translate-x-[14px]" : "translate-x-0.5"
            }`}
          />
        </span>
        <span className={`min-w-[1.1rem] text-[12px] font-semibold ${enabled ? "text-[#8fb0ff]" : "text-white/38"}`}>
          {enabled ? "开" : "关"}
        </span>
      </button>
    </GlassHoverTooltip>
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

// 评论查看&回复：顶部筛选各控件独立毛玻璃（无外层包裹条）
const REPLY_FILTER_FIELD =
  "rounded-xl border border-white/18 bg-white/[0.14] backdrop-blur-xl shadow-[0_8px_24px_rgba(0,0,0,0.35)] outline-none focus:border-white/28 transition-colors text-[15px]";

function ReplyTranslateToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <GlassHoverTooltip
      message="显示评论翻译（快捷键 ⌥T / Alt+T）"
      className="whitespace-nowrap">
      <button
        type="button"
        onClick={() => onChange(!enabled)}
        aria-pressed={enabled}
        aria-label="开关评论翻译"
        className={`${REPLY_FILTER_FIELD} flex items-center gap-2 px-3.5 py-2.5 text-[14px] ${
          enabled
            ? "text-white/95 ring-1 ring-[#5781d8]/35 border-[#5781d8]/30"
            : "text-white/65 hover:border-white/28"
        }`}>
        <Globe size={15} className={enabled ? "text-[#8fb0ff]" : "text-white/45"} strokeWidth={enabled ? 2.2 : 1.8} />
        <span className="font-medium">翻译</span>
        <span
          aria-hidden
          className={`relative inline-flex h-[18px] w-8 flex-none rounded-full transition-colors ${
            enabled ? "bg-[#5781d8]" : "bg-white/18"
          }`}>
          <span
            className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform ${
              enabled ? "translate-x-[14px]" : "translate-x-0.5"
            }`}
          />
        </span>
        <span className={`min-w-[1.1rem] text-[12px] font-semibold ${enabled ? "text-[#8fb0ff]" : "text-white/38"}`}>
          {enabled ? "开" : "关"}
        </span>
      </button>
    </GlassHoverTooltip>
  );
}

function ReplyLockedToolbarButton({
  label,
  icon: Icon,
  hint = LOCKED_UNAVAILABLE_HINT,
}: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  hint?: string;
}) {
  return (
    <GlassHoverTooltip message={hint} wrapClassName={`relative flex-none ${LOCKED_SURFACE_CURSOR}`}>
      <button
        type="button"
        disabled
        tabIndex={-1}
        aria-label={label}
        className={`${REPLY_FILTER_FIELD} flex items-center gap-2 px-3.5 py-2.5 text-[14px] text-white/35 opacity-60 pointer-events-none ${LOCKED_SURFACE_CURSOR}`}>
        <Icon size={15} className="text-white/30" strokeWidth={2} />
        <span className="font-medium whitespace-nowrap">{label}</span>
      </button>
    </GlassHoverTooltip>
  );
}

function ReplyReclassifyButton({
  locked = false,
  disabled,
  disabledReason,
  loading,
  count,
  onClick,
}: {
  locked?: boolean;
  disabled: boolean;
  disabledReason: string;
  loading: boolean;
  count: number;
  onClick: () => void;
}) {
  const visuallyDisabled = locked || disabled || loading;
  const hint = locked
    ? "暂无权限"
    : disabled
      ? disabledReason
      : `用当前 taxonomy 重新分类筛选结果（最多 ${RECLASSIFY_MAX} 条）。完成后标签可能变化，列表与统计会刷新。`;

  const button = (
    <button
      type="button"
      disabled={!locked && (disabled || loading)}
      onClick={locked ? undefined : onClick}
      aria-label="重跑当前筛选结果的分类"
      className={`${REPLY_FILTER_FIELD} flex items-center gap-2 px-3.5 py-2.5 text-[14px] transition-colors ${
        visuallyDisabled
          ? `text-white/35 opacity-60 ${locked ? LOCKED_SURFACE_CURSOR : "cursor-not-allowed"}`
          : "text-white/85 hover:border-white/28 hover:text-white/95"
      }`}>
      {loading ? (
        <Loader2 size={15} className="animate-spin text-[#8fb0ff]" />
      ) : (
        <RefreshCw size={15} className={visuallyDisabled ? "text-white/30" : "text-white/55"} strokeWidth={2} />
      )}
      <span className="font-medium whitespace-nowrap">
        {loading ? "重跑中…" : "重跑分类"}
      </span>
      {!loading && count > 0 && !visuallyDisabled && (
        <span className="text-[12px] font-semibold text-[#8fb0ff]">{count}</span>
      )}
    </button>
  );

  return (
    <GlassHoverTooltip message={hint} className={locked ? "whitespace-nowrap" : "w-max max-w-[18rem]"}>
      {button}
    </GlassHoverTooltip>
  );
}

function ClearChatButton({ contextLabel, onClick }: { contextLabel: string; onClick: () => void }) {
  return (
    <div className="relative pointer-events-auto">
      <GlassHoverTooltip
        message={`清空「${contextLabel}」下的对话`}
        className="whitespace-nowrap"
        wrapClassName="relative">
        <button
          type="button"
          onClick={onClick}
          aria-label={`清空「${contextLabel}」下的对话`}
          className="flex items-center gap-1.5 rounded-xl border border-white/12 bg-[#1a2233]/80 backdrop-blur-md px-3 py-1.5 text-[14px] text-white/65 hover:text-white/85 hover:border-white/22 hover:bg-[#1a2233] transition-colors">
          <Trash2 size={13} />
          清空此对话
        </button>
      </GlassHoverTooltip>
    </div>
  );
}

// 通用分段切换器：选中态做成一块"会滑动的磨砂玻璃胶囊"。胶囊用一个绝对定位的独立元素承载，
// 实时测量当前选项按钮的位置/尺寸，再用 transform 平滑滑过去——切换时胶囊在两个选项间丝滑滑动，
// 而不是直接在原地换底色。按钮自身只负责文字颜色过渡，盖在胶囊之上（z-10）。
// ResizeObserver 跟着轨道/按钮尺寸变化重测（左栏展开动画、窗口缩放、选项增减都能跟上）。
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = "",
  itemClassName = "px-3.5 py-1.5 text-[14px]",
  fill = false,
}: {
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  itemClassName?: string;
  fill?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<T, HTMLButtonElement>());
  const [pill, setPill] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const optionsKey = options.map((o) => o.value).join("|");

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const active = itemRefs.current.get(value);
      if (!active) return;
      setPill({ left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    itemRefs.current.forEach((b) => ro.observe(b));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, optionsKey]);

  return (
    <div ref={trackRef} className={`relative ${SEG_TRACK} ${className}`}>
      {pill && (
        <span
          aria-hidden
          className={`pointer-events-none absolute left-0 top-0 rounded-full ${SEG_PILL_ON} transition-[transform,width,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]`}
          style={{
            transform: `translate(${pill.left}px, ${pill.top}px)`,
            width: pill.width,
            height: pill.height,
          }}
        />
      )}
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            ref={(node) => {
              if (node) itemRefs.current.set(opt.value, node);
              else itemRefs.current.delete(opt.value);
            }}
            onClick={() => onChange(opt.value)}
            title={opt.title}
            className={`relative z-10 flex items-center justify-center gap-1.5 rounded-full whitespace-nowrap transition-colors ${
              fill ? "flex-1" : ""
            } ${itemClassName} ${active ? "text-white font-bold" : `${SEG_PILL_OFF} font-medium`}`}>
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="ask-md text-white/88 [&_h1]:mb-4 [&_h1]:mt-1 [&_h1]:text-[24px] [&_h1]:leading-snug [&_h1]:font-bold [&_h1]:text-white [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:pb-2.5 [&_h2]:text-[21px] [&_h2]:leading-snug [&_h2]:font-bold [&_h2]:text-white [&_h2]:border-b [&_h2]:border-white/10 [&_h2:first-child]:mt-0 [&_h3]:mb-2.5 [&_h3]:mt-4 [&_h3]:text-[19px] [&_h3]:leading-snug [&_h3]:font-semibold [&_h3]:text-white [&_p]:mb-3.5 [&_p]:last:mb-0 [&_p]:text-[17px] [&_p]:leading-[1.75] [&_p]:text-white/75 [&>ol]:mb-1 [&>ol]:list-none [&>ol]:space-y-0 [&>ol]:pl-0 [&>ol>li]:border-t [&>ol>li]:border-white/10 [&>ol>li]:py-3.5 [&>ol>li]:text-[18px] [&>ol>li]:font-semibold [&>ol>li]:leading-snug [&>ol>li]:text-white [&>ol>li:first-child]:border-t-0 [&>ol>li:first-child]:pt-0 [&>ol>li_ul]:mt-2.5 [&>ol>li_ul]:list-[circle] [&>ol>li_ul]:space-y-1.5 [&>ol>li_ul]:pl-5 [&>ol>li_ul>li]:text-[16px] [&>ol>li_ul>li]:font-normal [&>ol>li_ul>li]:leading-[1.7] [&>ol>li_ul>li]:text-white/72 [&>ul:not(ol_li_ul)]:mb-3.5 [&>ul:not(ol_li_ul)]:list-disc [&>ul:not(ol_li_ul)]:space-y-1.5 [&>ul:not(ol_li_ul)]:pl-5 [&>ul:not(ol_li_ul)>li]:text-[17px] [&>ul:not(ol_li_ul)>li]:leading-[1.7] [&>ul:not(ol_li_ul)>li]:text-white/78 [&_ul_ul]:list-[circle] [&_ul_ul]:mt-1.5 [&_strong]:font-semibold [&_strong]:text-white [&_hr]:my-5 [&_hr]:border-white/12">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          h4: ({ children }) => <h4 className="mb-2 mt-3 text-[18px] leading-snug font-semibold text-white">{children}</h4>,
          p: ({ children }) => <p>{children}</p>,
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          strong: ({ children }) => <strong>{children}</strong>,
          hr: () => <hr />,
          table: ({ children }) => (
            <div className="overflow-x-auto mb-4 -mx-1 px-1">
              <table className="w-full min-w-[16rem] text-[15px] border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead>{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-b border-white/8 last:border-0">{children}</tr>,
          th: ({ children }) => <th className="text-left py-2.5 pr-4 font-semibold text-white/88 align-bottom">{children}</th>,
          td: ({ children }) => <td className="py-2.5 pr-4 align-top leading-[1.65] text-white/75">{children}</td>,
          code: ({ children }) => <code className="px-1.5 py-0.5 rounded bg-white/10 text-white/90 text-[15px]">{children}</code>,
          pre: ({ children }) => <pre className="overflow-x-auto rounded-xl bg-black/25 p-4 mb-4 text-[15px] leading-relaxed">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-white/28 pl-4 text-white/72 mb-3.5 text-[16px] leading-[1.7]">{children}</blockquote>
          ),
        }}>
        {content}
      </ReactMarkdown>
    </div>
  );
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

// 单调三次样条（Fritsch–Carlson，同 d3 的 curveMonotoneX）：把折线画成平滑曲线，
// 同时保证不"过冲"——曲线不会鼓到比真实数据点更高/更低的地方（评分轴固定 1~5，普通
// Catmull-Rom 会在波峰冲出 5、波谷跌破谷值，看着像假数据，这里用单调样条避免）。
function buildSmoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  const fmt = (v: number) => v.toFixed(1);
  if (n === 1) return `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  if (n === 2) return `M ${fmt(pts[0].x)} ${fmt(pts[0].y)} L ${fmt(pts[1].x)} ${fmt(pts[1].y)}`;

  const dx: number[] = [];
  const slope: number[] = []; // 相邻两点的割线斜率
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x || 1e-6;
    dx.push(h);
    slope.push((pts[i + 1].y - pts[i].y) / h);
  }

  const tangent: number[] = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0; // 极值点处切线压平，杜绝过冲
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    const c1x = pts[i].x + h / 3;
    const c1y = pts[i].y + (tangent[i] * h) / 3;
    const c2x = pts[i + 1].x - h / 3;
    const c2y = pts[i + 1].y - (tangent[i + 1] * h) / 3;
    d += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(pts[i + 1].x)} ${fmt(pts[i + 1].y)}`;
  }
  return d;
}

// 评分随真实日期走的折线图：横轴按实际天数间距（不是均匀分类摆放），纵轴固定 1~5（评分本身的
// 天然量程，不做自动缩放，避免轴范围操纵带来的误导）；圆点面积与当天评论量成正比（半径按 √count
// 定标），定标上限取当前点集（已按所选地区筛选）的峰值，不用全地区合并峰值。
function RatingTrendChart({
  points,
  overallAvg,
  height = 200,
}: {
  points: { date: string; avgRating: number; count: number }[];
  overallAvg: number;
  height?: number;
}) {
  if (points.length === 0) {
    return <div style={{ height }} className="flex items-center justify-center text-white/35 text-[13px]">暂无数据</div>;
  }
  const width = 1000;
  const dateAxisH = 22;
  const chartH = height + dateAxisH;
  const labelW = 30;
  const dotMaxR = 7;
  const plotLeft = labelW + dotMaxR;
  const plotRight = width - dotMaxR;
  const plotW = plotRight - plotLeft;
  const yPad = dotMaxR;
  const plotH = height - yPad * 2;
  const minTime = new Date(points[0].date).getTime();
  const maxTime = new Date(points[points.length - 1].date).getTime();
  const timeSpan = Math.max(maxTime - minTime, 86400000);
  const x = (date: string) => plotLeft + ((new Date(date).getTime() - minTime) / timeSpan) * plotW;
  const y = (rating: number) => yPad + plotH - ((rating - 1) / 4) * plotH;
  const scaleMax = Math.max(...points.map((p) => p.count), 1);
  const dotRadius = (count: number) => dotMaxR * Math.sqrt(count / scaleMax);
  const pathD = buildSmoothPath(points.map((p) => ({ x: x(p.date), y: y(p.avgRating) })));
  const labelEvery = points.length > 12 ? Math.ceil(points.length / 8) : 1;
  const yLabelPct = (rating: number) => `${(y(rating) / height) * 100}%`;

  return (
    <div className="relative w-full" style={{ height: chartH }}>
      <svg viewBox={`0 0 ${width} ${chartH}`} className="w-full block overflow-visible" style={{ height: chartH }} preserveAspectRatio="none">
        {[1, 2, 3, 4, 5].map((star) => (
          <line key={`grid-${star}`} x1={plotLeft} y1={y(star)} x2={plotRight} y2={y(star)}
            stroke="rgba(255,255,255,0.32)" strokeWidth={1} />
        ))}
        <line x1={plotLeft} y1={y(overallAvg)} x2={plotRight} y2={y(overallAvg)}
          stroke="#5781d8" strokeWidth={1.5} strokeDasharray="6 4" />
        <path d={pathD} fill="none" stroke={THEME_BLUE} strokeWidth={2} />
        {points.map((p) => {
          const r = dotRadius(p.count);
          const opacity = 0.45 + (p.count / scaleMax) * 0.55;
          return (
            <circle key={p.date} cx={x(p.date)} cy={y(p.avgRating)} r={r} fill={THEME_BLUE} opacity={opacity}>
              <title>{p.date}：均分 {p.avgRating}，{p.count} 条评论</title>
            </circle>
          );
        })}
        {points.map((p, i) => (
          i % labelEvery === 0 && (
            <text key={p.date} x={x(p.date)} y={height + 16} fontSize={10} fill="rgba(255,255,255,0.55)"
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
              {p.date.slice(5)}
            </text>
          )
        ))}
      </svg>
      {/* 刻度叠在图左侧，不占宽度；SVG 仍 w-full 1000 */}
      <div className="pointer-events-none absolute left-0 top-0 w-10 pr-0.5" style={{ height }}>
        {[5, 4, 3, 2, 1].map((star) => (
          <span key={star} className="absolute right-0 -translate-y-1/2 text-[11px] tabular-nums text-white/70 text-right w-full"
            style={{ top: yLabelPct(star) }}>
            {star}
          </span>
        ))}
      </div>
    </div>
  );
}

function fmtDate(iso: string | null) {
  return iso ? iso.slice(0, 10) : "—";
}

// Top 反馈 / 评论查看&回复头部共用 TagBreakdown。规则见 .cursor/rules/top-feedback-tagging.mdc：
// praise、vague_complaint 无 breakdown；其余类有效子标签 ≥2 → chip，否则 → summarizeCluster 中文摘要（evidence 不作 UI 文案）。
function TagBreakdown({ t, onJump, activeSubKey }: {
  t: { count: number; summary: string | null; subTags: Record<string, { label: string; count: number }> };
  onJump?: (subKey?: string) => void;
  activeSubKey?: string;
}) {
  const subEntries = sortSubTagRecordForDisplay(t.subTags);
  if (!hasSubTagBreakdown(t.subTags)) {
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

function InlineLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-white/30 animate-[pulse_1.2s_ease-in-out_infinite]" />
        <span className="w-1.5 h-1.5 rounded-full bg-white/40 animate-[pulse_1.2s_ease-in-out_200ms_infinite]" />
        <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-[pulse_1.2s_ease-in-out_400ms_infinite]" />
      </div>
      <p className="mt-3 text-white/45 text-[13px] tracking-wide">{label}</p>
    </div>
  );
}

function InlineLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <p className="text-white/65 text-[14px] leading-relaxed mb-4">{message}</p>
      <button onClick={onRetry}
        className="px-4 py-2 rounded-xl text-[14px] text-white/90 bg-white/10 hover:bg-white/15 transition-colors">
        重试
      </button>
    </div>
  );
}

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
  const [timeRangeRaw, setTimeRangeRaw] = useQueryState("range", DEFAULT_DEMO_TIME_RANGE);
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
  const [translateSettings, setTranslateSettings] = useState<TranslateSettings>(() =>
    loadJsonSetting(TRANSLATE_SETTINGS_KEY, DEFAULT_TRANSLATE_SETTINGS)
  );
  const [askSettings, setAskSettings] = useState<AskSettings>(() =>
    loadJsonSetting(ASK_SETTINGS_KEY, DEFAULT_ASK_SETTINGS)
  );
  const [terminologyDraft, setTerminologyDraft] = useState<TerminologyEntry[]>([]);
  const [leftSidebarView, setLeftSidebarView] = useState<LeftSidebarView>("filter");
  const [canReclassify, setCanReclassify] = useState(false);
  const [showAppMenu, setShowAppMenu] = useState(false);
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [bootReady, setBootReady] = useState(false);
  const [bootError, setBootError] = useState("");

  const [stats, setStats] = useState<Stats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState("");
  // "评分趋势/评分分布/地区满意度"是同一份评分数据的三种切面，合并成一张卡片用切换器选看哪个，
  // 不用三张卡片各占一块地方。选中具体地区后"地区满意度"这个切面本身没意义（已经聚焦到一个
  // 地区了），这时候要是还停在这个切面上，自动切回"趋势"，不能留着空切面晃在那
  const [ratingView, setRatingView] = useState<RatingView>("trend");
  useEffect(() => { if (locale && ratingView === "locale") setRatingView("trend"); }, [locale, ratingView]);
  useEffect(() => { if (leftSidebarView === "settings") setShowAppMenu(false); }, [leftSidebarView]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/demo/permissions")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setCanReclassify(Boolean(data.reclassify));
      })
      .catch(() => {
        if (!cancelled) setCanReclassify(false);
      });
    return () => { cancelled = true; };
  }, []);

  const [reviews, setReviews] = useState<ReviewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [replyStatusCounts, setReplyStatusCounts] = useState<ReplyStatusCounts | null>(null);
  const [loading, setLoading] = useState(false);

  const [selectedReview, setSelectedReview] = useState<ReviewRow | null>(null);
  const [aiReply, setAiReply] = useState("");
  const [aiReplyTranslation, setAiReplyTranslation] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [reclassifyLoading, setReclassifyLoading] = useState(false);
  const [reclassifyFeedback, setReclassifyFeedback] = useState("");
  const [statsFresh, setStatsFresh] = useState(false);
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [showClearChatConfirm, setShowClearChatConfirm] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatStopRequestedRef = useRef(false);
  const chatRequestStartedAtRef = useRef(0);
  const chatBusyRef = useRef(false);
  // 流式输出跟滚：用户一旦主动往上滑就锁定，直到滚回底部或发送新问题
  const chatStickToBottomRef = useRef(true);
  const chatUserDetachedRef = useRef(false);
  const chatAutoScrollingRef = useRef(false);
  const chatMessagesRef = useRef(chatMessages);
  chatMessagesRef.current = chatMessages;
  const prevAskChatStorageKeyRef = useRef<string | null>(null);
  const skipNextChatPersistRef = useRef(false);
  const pendingChatScrollRef = useRef<"top" | "bottom" | null>(null);
  const composingRef = useRef(false);
  const replyDetailRef = useRef<HTMLDivElement>(null);
  const reviewsReqIdRef = useRef(0);
  const statsReqIdRef = useRef(0);

  const selectedApp = apps.find((a) => a.id === selectedAppId);

  useEffect(() => {
    if (!selectedApp) {
      setTerminologyDraft([]);
      return;
    }
    setTerminologyDraft(
      (selectedApp.terminology_glossary ?? []).map((e) => ({
        source: e.source ?? "",
        zh: e.zh ?? "",
        en: e.en ?? "",
        note: e.note ?? "",
      }))
    );
  }, [selectedAppId, selectedApp?.terminology_glossary, selectedApp]);

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
  const askDraftStorageKey = askContextStorageKey(ASK_DRAFT_STORAGE_PREFIX, selectedAppId, timeRange, locale);
  const askChatStorageKey = askContextStorageKey(ASK_CHAT_STORAGE_PREFIX, selectedAppId, timeRange, locale);

  const reclassifyBlockedReason = useMemo(() => {
    if (!tagFilter) return "请先选择问题类型";
    if (loading || reclassifyLoading) return "请等待加载完成";
    if (total === 0) return "当前筛选下没有评论";
    if (total > RECLASSIFY_MAX) {
      return `超过 ${RECLASSIFY_MAX} 条上限（当前 ${total.toLocaleString()} 条），请缩小筛选范围`;
    }
    return "";
  }, [tagFilter, loading, reclassifyLoading, total]);

  // ⌘B / Ctrl+B 切换左侧栏；⌥1~4 / Alt+1~4 切换右侧栏目；评论查看&回复下 ⌥T / Alt+T 开关翻译。
  // 逻辑同时认 metaKey/ctrlKey 与 altKey，Mac 与 Windows 都生效；面板用中性写法同时标注两套修饰键，
  // 不依赖平台检测。输入框聚焦时不拦截，避免组合键打出特殊字符或触发浏览器菜单。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setLeftOpen((v) => !v);
        return;
      }

      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (isEditableTarget(e.target)) return;

      const digit = e.code.match(/^Digit([1-4])$/)?.[1];
      if (digit) {
        const panel = RIGHT_PANEL_NAV[Number(digit) - 1]?.key;
        if (panel) {
          e.preventDefault();
          setActivePanel(panel);
        }
        return;
      }

      if (e.code === "KeyT" && activePanel === "reply") {
        e.preventDefault();
        setTranslateSettings((s) => ({ ...s, enabled: !s.enabled }));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePanel, setActivePanel]);

  // 拉 App 列表，默认选 Demo 指定 App（HOK），找不到则退回列表第一项
  useEffect(() => {
    let cancelled = false;
    fetch("/api/demo/apps")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `App 列表加载失败 (${r.status})`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setApps(data.apps ?? []);
        setBootError("");
        const list = data.apps ?? [];
        if (list.length && selectedAppId && !list.some((a: AppRow) => a.id === selectedAppId)) {
          const defaultApp = resolveDefaultDemoApp(list);
          if (defaultApp) setSelectedAppId(defaultApp.id);
        } else if (list.length && !selectedAppId) {
          const defaultApp = resolveDefaultDemoApp(list);
          if (defaultApp) setSelectedAppId(defaultApp.id);
        }
      })
      .catch((e) => {
        if (!cancelled) setBootError(e.message || "App 列表加载失败");
      });
    return () => { cancelled = true; };
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
    if (statsFresh) params.set("fresh", "1");
    const reqId = ++statsReqIdRef.current;
    setStatsLoading(true);
    setStatsError("");
    fetch(`/api/demo/stats?${params}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `统计加载失败 (${r.status})`);
        return data;
      })
      .then((data) => {
        if (reqId !== statsReqIdRef.current) return;
        setStats(data);
        if (statsFresh) setStatsFresh(false);
      })
      .catch((e) => {
        if (reqId !== statsReqIdRef.current) return;
        setStatsError(e.message || "统计加载失败");
      })
      .finally(() => {
        if (reqId === statsReqIdRef.current) setStatsLoading(false);
      });
  }, [selectedAppId, selectedApp, locale, since, dataRefreshKey, statsFresh]);

  // 拉评论列表（筛选/翻页变化时）
  // 筛选一变，这个 effect 会先用旧 page 发一次请求，紧接着翻页重置 effect 再用 page=1 发一次；
  // 两次请求没有时序保证，要是先发的那次（可能落在一个空页上）反而后返回，就会把正确结果覆盖成空，
  // 表现为"评论区有时候不显示"。用一个自增的请求序号当守卫，只让最新一次请求的结果落地、丢弃过期返回。
  useEffect(() => {
    if (!selectedAppId || !selectedApp) return;
    setLoading(true);
    const reqId = ++reviewsReqIdRef.current;
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
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || `评论加载失败 (${r.status})`);
        return data;
      })
      .then((data) => {
        if (reqId !== reviewsReqIdRef.current) return;
        setReviews(data.items ?? []);
        setTotal(data.total ?? 0);
        setReplyStatusCounts(data.replyCounts ?? null);
        setBootError("");
      })
      .catch((e) => {
        if (reqId !== reviewsReqIdRef.current) return;
        setBootError(e.message || "评论加载失败");
        setReviews([]);
        setTotal(0);
        setReplyStatusCounts(null);
      })
      .finally(() => {
        if (reqId === reviewsReqIdRef.current) setLoading(false);
      });
  }, [selectedAppId, selectedApp, locale, tagFilter, subTagFilter, search, repliedFilter, page, since, dataRefreshKey]);

  useEffect(() => {
    if (bootReady) return;
    if (!selectedAppId || !selectedApp) return;
    if (loading) return;
    const t = window.setTimeout(() => setBootReady(true), 220);
    return () => window.clearTimeout(t);
  }, [bootReady, selectedAppId, selectedApp, loading]);

  const showDataLoading = !bootReady;

  // 切筛选条件时回到第一页（page 已经是 1 就不用再多触发一次 URL replace）
  useEffect(() => { if (page !== 1) setPage(1); }, [selectedAppId, locale, tagFilter, subTagFilter, search, repliedFilter, since]);
  useEffect(() => { setReclassifyFeedback(""); }, [selectedAppId, locale, tagFilter, subTagFilter, search, repliedFilter, since]);

  function scrollChatToBottomIfNeeded() {
    if (chatUserDetachedRef.current || !chatStickToBottomRef.current) return;
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    chatAutoScrollingRef.current = true;
    viewport.scrollTop = viewport.scrollHeight;
    requestAnimationFrame(() => {
      chatAutoScrollingRef.current = false;
    });
  }

  function detachChatFollow() {
    chatUserDetachedRef.current = true;
    chatStickToBottomRef.current = false;
  }

  function resetChatFollow() {
    chatUserDetachedRef.current = false;
    chatStickToBottomRef.current = true;
  }

  // useLayoutEffect：DOM 更新后、绘制前跟滚，比 useEffect 少一帧滞后
  useLayoutEffect(() => {
    const pending = pendingChatScrollRef.current;
    if (pending) {
      pendingChatScrollRef.current = null;
      const viewport = chatViewportRef.current;
      if (viewport) {
        chatAutoScrollingRef.current = true;
        resetChatFollow();
        viewport.scrollTop = viewport.scrollHeight;
        requestAnimationFrame(() => {
          chatAutoScrollingRef.current = false;
        });
      }
      return;
    }
    scrollChatToBottomIfNeeded();
  }, [chatMessages, chatLoading]);

  function handleChatViewportWheel(e: React.WheelEvent) {
    // 比 onScroll 更早拦截：用户往上滑的瞬间就停止跟滚，避免和逐字更新抢滚动条
    if (e.deltaY < 0) detachChatFollow();
  }

  function handleChatViewportScroll() {
    if (chatAutoScrollingRef.current) return;
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    const distFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distFromBottom < 8) {
      resetChatFollow();
    } else if (distFromBottom > 64) {
      detachChatFollow();
    }
  }

  useEffect(() => {
    if (!selectedReview) return;
    const onPointerDown = (e: MouseEvent) => {
      const el = e.target as Element;
      if (replyDetailRef.current?.contains(el)) return;
      // 点在评论卡片上时不关闭——否则 mousedown 先关、click 再开，会闪一下
      if (el.closest("[data-review-card]")) return;
      setSelectedReview(null);
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

  // 问 AI 聊天记录按 App + 时间范围 + locale 分桶；切换上下文时保存旧桶、载入新桶，并重置滚动，
  // 避免长聊后 scrollTop 仍停在底部导致空状态提示「看不见」、或继续展示上一 App 的对话。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prevKey = prevAskChatStorageKeyRef.current;
    if (prevKey === askChatStorageKey) return;

    if (prevKey !== null) {
      try {
        window.localStorage.setItem(prevKey, JSON.stringify(chatMessagesRef.current));
      } catch {
        // ignore
      }
    }

    let loaded: ChatMessage[] = [];
    try {
      const saved = window.localStorage.getItem(askChatStorageKey);
      if (saved) loaded = JSON.parse(saved) as ChatMessage[];
    } catch {
      loaded = [];
    }
    setChatMessages(loaded);
    prevAskChatStorageKeyRef.current = askChatStorageKey;
    skipNextChatPersistRef.current = true;
    setShowClearChatConfirm(false);

    chatStopRequestedRef.current = true;
    chatAbortRef.current?.abort();
    chatBusyRef.current = false;
    setChatLoading(false);
    if (loaded.length === 0) {
      chatUserDetachedRef.current = false;
      chatStickToBottomRef.current = true;
      pendingChatScrollRef.current = null;
      // 目标桶也是空会话时 React 可能因 chatMessages 仍是 [] 而不重渲染，这里直接复位 scrollTop
      if (chatViewportRef.current) chatViewportRef.current.scrollTop = 0;
    } else {
      pendingChatScrollRef.current = "bottom";
    }
  }, [askChatStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (skipNextChatPersistRef.current) {
      skipNextChatPersistRef.current = false;
      return;
    }
    try {
      window.localStorage.setItem(askChatStorageKey, JSON.stringify(chatMessages));
    } catch {
      // ignore
    }
  }, [askChatStorageKey, chatMessages]);

  useEffect(() => {
    saveJsonSetting(TRANSLATE_SETTINGS_KEY, translateSettings);
  }, [translateSettings]);

  useEffect(() => {
    saveJsonSetting(ASK_SETTINGS_KEY, askSettings);
  }, [askSettings]);

  function calcChatInputHeight(el: HTMLTextAreaElement) {
    const max = Math.min(Math.floor(window.innerHeight * 0.45), 420);
    el.style.height = "auto";
    const next = Math.max(52, Math.min(el.scrollHeight, max));
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

  function setMessageAnswer(messageId: string, text: string) {
    setChatMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, a: text } : m)));
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

  function handleClearChat() {
    chatStopRequestedRef.current = true;
    chatAbortRef.current?.abort();
    chatBusyRef.current = false;
    setChatLoading(false);
    skipNextChatPersistRef.current = true;
    try {
      window.localStorage.removeItem(askChatStorageKey);
    } catch {
      // ignore
    }
    setChatMessages([]);
    chatUserDetachedRef.current = false;
    chatStickToBottomRef.current = true;
    if (chatViewportRef.current) chatViewportRef.current.scrollTop = 0;
    setShowClearChatConfirm(false);
  }

  const askContextLabel = locale
    ? `${appName} · ${timeRangeLabel} · ${localeLabel(locale)}`
    : `${appName} · ${timeRangeLabel}`;
  const canClearChat = chatMessages.length > 0;

  // 真实调AI回答——把当前筛选范围内的真实统计数字喂给DeepSeek，不是预设话术匹配
  async function handleSendChat() {
    // 兼容同一帧内的二次点击：即使还没 re-render，也能立即走"停止"
    if (chatBusyRef.current) {
      handleStopChat();
      return;
    }
    const q = chatInput.trim();
    if (!q || !selectedAppId || chatLoading) return;
    // 把当前已完成的问答带上当上下文——闭包里的 chatMessages 还是追加新消息之前的值，
    // 正好是历史轮次（都已经有 a），新问题不在里面，不会自己问自己。
    const history = chatMessages
      .filter((m) => m.a.trim())
      .slice(-8)
      .map((m) => ({ q: m.q, a: m.a }));
    chatStopRequestedRef.current = false;
    resetChatFollow();
    chatBusyRef.current = true;
    const msgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    chatAbortRef.current = controller;
    chatRequestStartedAtRef.current = Date.now();
    setChatMessages((prev) => [...prev, { id: msgId, q, a: "" }]);
    setChatInput("");
    if (chatInputRef.current) {
      chatInputRef.current.style.height = "52px";
      chatInputRef.current.style.overflowY = "hidden";
    }
    setChatLoading(true);
    try {
      const res = await fetch("/api/demo/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          question: q,
          appId: selectedAppId,
          locale,
          since,
          timeRangeLabel,
          history,
          useEmoji: askSettings.useEmoji,
          useThinking: askSettings.useThinking,
        }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        setMessageAnswer(msgId, `回答失败：${data?.error || "请求失败，请重试。"}`);
        return;
      }
      // 读 NDJSON 流：真实 token 边到边渲染，不再等整段返回、也不靠假打字延时
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      let streamErr = "";
      const handleEvent = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: { type: string; text?: string; message?: string };
        try {
          ev = JSON.parse(trimmed);
        } catch {
          return;
        }
        if (ev.type === "delta" && ev.text) {
          acc += ev.text;
          setMessageAnswer(msgId, acc);
        } else if (ev.type === "replace" && typeof ev.text === "string") {
          acc = ev.text;
          setMessageAnswer(msgId, acc);
        } else if (ev.type === "error") {
          streamErr = ev.message || "回答失败";
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleEvent(line);
      }
      if (buffer) handleEvent(buffer);
      if (streamErr) setMessageAnswer(msgId, `回答失败：${streamErr}`);
      else if (!acc) setMessageAnswer(msgId, "暂无回答");
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || chatStopRequestedRef.current) {
        return;
      }
      setMessageAnswer(msgId, "请求失败，请重试。");
    } finally {
      chatAbortRef.current = null;
      chatBusyRef.current = false;
      setChatLoading(false);
    }
  }

  function handleSelectReview(r: ReviewRow) {
    if (selectedReview?.id === r.id) {
      setSelectedReview(null);
      return;
    }
    setSelectedReview(r);
    setAiReply("");
    setAiReplyTranslation(null);
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
          appId: selectedAppId,
          replyContext: {
            tone: DEFAULT_AI_REPLY_SETTINGS.tone,
            style: DEFAULT_AI_REPLY_SETTINGS.style,
            contactInfo: DEFAULT_AI_REPLY_SETTINGS.contactInfo,
          },
          translateSettings,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAiError(data.error || "生成失败");
      } else {
        setAiReply(data.reply);
        setAiReplyTranslation(data.translation ?? null);
      }
    } catch {
      setAiError("请求失败，请重试");
    } finally {
      setAiLoading(false);
    }
  }

  async function handleReclassify() {
    if (!canReclassify || reclassifyBlockedReason || reclassifyLoading || !tagFilter) return;
    const tagStats = stats?.tagCounts[tagFilter];
    const parts = [`问题类型：${tagStats?.label ?? tagFilter}`];
    if (subTagFilter && tagStats?.subTags[subTagFilter]) {
      parts.push(`子问题：${tagStats.subTags[subTagFilter].label}`);
    }
    if (locale) parts.push(`地区：${localeLabel(locale)}`);
    if (search) parts.push(`搜索：${search}`);
    if (repliedFilter !== undefined) parts.push(repliedFilter ? "已回复" : "未回复");
    parts.push(`共 ${total.toLocaleString()} 条（单次上限 ${RECLASSIFY_MAX}）`);

    if (
      !window.confirm(
        `将用当前 taxonomy 重新分类以下筛选结果：\n\n${parts.join("\n")}\n\n完成后标签可能变化，列表与统计会刷新。确定继续？`
      )
    ) {
      return;
    }

    setReclassifyLoading(true);
    setReclassifyFeedback("");
    try {
      const res = await fetch("/api/demo/reviews/reclassify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: selectedAppId,
          since,
          locale: locale || undefined,
          tag: tagFilter,
          subTag: subTagFilter || undefined,
          q: search || undefined,
          replied: repliedFilter,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReclassifyFeedback(data.error || "重跑失败");
        return;
      }
      setSelectedReview(null);
      setAiReply("");
      setAiReplyTranslation(null);
      setStatsFresh(true);
      setDataRefreshKey((k) => k + 1);
      const summaryNote =
        data.summariesRefreshed > 0 ? `，已刷新 ${data.summariesRefreshed} 个标签摘要` : "";
      setReclassifyFeedback(
        data.failed > 0
          ? `已完成：成功 ${data.succeeded} 条，失败 ${data.failed} 条${summaryNote}`
          : `已重跑 ${data.succeeded} 条评论的分类${summaryNote}`
      );
    } catch {
      setReclassifyFeedback("请求失败，请重试");
    } finally {
      setReclassifyLoading(false);
    }
  }

  // 跳转到某个标签（可带具体子问题）的评论列表时，保留当前已选的地区/时间范围筛选。
  // tag / subTag / panel 三个 URL 参数必须在同一次 push 里改完——之前分三次调 setter，
  // 互相覆盖，结果只有最后一个生效，标签压根没设上，所以点了没反应（这就是"点击进不去"的根因）。
  function jumpToTag(tag: string, subTag?: string) {
    setParams({ tag, subTag: subTag ?? "", panel: "reply" });
  }

  const rightPanelItems = RIGHT_PANEL_NAV.map((item) => ({
    ...item,
    icon: PANEL_ICONS[item.key],
  }));

  const allLocalesTotal = stats?.windowReviewTotal ?? 0;
  const avgRating = stats
    ? Math.round(
        (Object.entries(stats.ratingDist).reduce((sum, [k, v]) => sum + Number(k) * v, 0) / stats.total) * 100
      ) / 100
    : null;

  // ── 中间区域：分析结果 ──
  const AnalyzeResult = (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      {activePanel !== "reply" && activePanel !== "ask" && !stats && statsLoading && (
        <InlineLoading label="统计数据加载中…" />
      )}
      {activePanel !== "reply" && activePanel !== "ask" && !stats && !statsLoading && statsError && (
        <InlineLoadError message={statsError} onRetry={() => setDataRefreshKey((k) => k + 1)} />
      )}

      {activePanel === "complaints" && stats && (
        <div>
          <p className="text-white/75 text-[14px] mb-4">
            {locale ? localeLabel(locale) : "全部语言/地区批次"}：{timeRangeLabel}（{fmtDate(stats.dateRange.from)} ~ {fmtDate(stats.dateRange.to)}）共 {stats.total.toLocaleString()} 条公开评论：
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
            一条评论可能命中多个 Tag，评论计数可能小于命中 Tag 总数之和。
          </p>
        </div>
      )}

      {activePanel === "analysis" && stats && (() => {
        const sorted = Object.entries(stats.tagCounts).sort((a, b) => b[1].count - a[1].count);

        // 诉求占比的颜色：按排序后的序号循环取通用调色板，不跟具体 tag key 绑定
        const sliceColors = sorted.map((_, i) => CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]);

        // 评分分布：好评(4-5★)/差评(1-2★)/中评(3★)三段占比
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
                  <SegmentedControl<RatingView>
                    value={ratingView}
                    onChange={setRatingView}
                    itemClassName="px-3 py-1 text-[13px]"
                    options={[
                      { value: "trend", label: "趋势", icon: <LineChart size={13} /> },
                      { value: "distribution", label: "分布", icon: <BarChart2 size={13} /> },
                      ...(!locale ? [{ value: "locale" as RatingView, label: "地区", icon: <Globe size={13} /> }] : []),
                    ]}
                  />
                </div>

                {ratingView === "trend" && (
                  <>
                    <div className="flex items-baseline gap-3 mb-1">
                      <span className="text-[42px] font-bold text-white">{avgRating}</span>
                      <span className="text-white/68 text-[16px]">{timeRangeLabel}平均分</span>
                    </div>
                    <p className="text-white/60 text-[14px] mb-5">
                      {appName} · {fmtDate(stats.dateRange.from)} ~ {fmtDate(stats.dateRange.to)} · Google Play · 共 {stats.total} 条
                      {locale ? `（${localeLabel(locale)}）` : ""}，圆点面积与当天{locale ? "该地区" : ""}评论量成正比
                    </p>
                    <RatingTrendChart key={locale || "all"} points={stats.dailyRatings} overallAvg={avgRating ?? 0} />
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

            <div className="md:col-start-2 flex flex-col gap-5">
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
              </div>

              <GlassHoverTooltip
                message={LOCKED_UNAVAILABLE_HINT}
                placement="top-center"
                className="whitespace-nowrap"
                wrapClassName={`relative block w-full ${LOCKED_SURFACE_CURSOR}`}>
                <div className="bg-[#242c3d] rounded-3xl p-6 opacity-60">
                  <div className="flex items-start gap-3">
                    <div className="flex-none w-9 h-9 rounded-xl bg-white/8 flex items-center justify-center">
                      <Mail size={16} className="text-white/45" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-white/90 text-[18px] font-bold mb-1">自定义周报订阅</p>
                      <p className="text-white/50 text-[13px] leading-relaxed">
                        按你关心的标签与地区，定时接收 AI 汇总的周报摘要。
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled
                    tabIndex={-1}
                    className={`mt-4 w-full rounded-xl border border-white/12 bg-white/[0.06] px-3 py-2 text-[13px] text-white/40 pointer-events-none ${LOCKED_SURFACE_CURSOR}`}>
                    敬请期待
                  </button>
                </div>
              </GlassHoverTooltip>
            </div>

          </div>
        );
      })()}
    </div>
  );

  // ── 中间区域：问 AI ──
  const AskResult = (
    <div className="relative flex-1 overflow-hidden">
      {canClearChat && (
        <div className="absolute top-0 inset-x-0 z-20 px-6 pt-4 flex items-center justify-end pointer-events-none">
          <ClearChatButton
            contextLabel={askContextLabel}
            onClick={() => setShowClearChatConfirm(true)}
          />
        </div>
      )}
      <div
        ref={chatViewportRef}
        onWheel={handleChatViewportWheel}
        onScroll={handleChatViewportScroll}
        className={`absolute inset-0 overflow-y-auto px-6 pb-36 [overflow-anchor:none] ${canClearChat ? "pt-14" : "pt-6"}`}
      >
        {chatMessages.length === 0 && !chatLoading ? (
          <div className="max-w-3xl mx-auto text-white/60 text-[19px] leading-relaxed">
            <p className="font-medium text-white/80">问我关于 {appName} {timeRangeLabel} 的评论的任何问题</p>
            <p className="text-white/40 text-[14px] mt-3 leading-relaxed">
              单次询问context上限：{ASK_SUMMARIZE_MAX}条评论
            </p>
            <p className="text-white/40 text-[14px] mt-2 leading-relaxed">
              对话记录保存在本机浏览器，换设备或清除缓存后会丢失。
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto w-full flex flex-col gap-8">
            {chatMessages.map((m, i) => (
              <div key={m.id} className="space-y-4">
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl bg-[#4b5f9f] text-white px-4 py-3 text-[18px] leading-relaxed shadow-[0_8px_24px_rgba(87,129,216,0.25)]">
                    {m.q}
                  </div>
                </div>
                <div className="w-full text-[18px] text-white leading-relaxed">
                  <MarkdownMessage content={m.a || (chatLoading && i === chatMessages.length - 1 ? "正在组织回答…" : "")} />
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex items-center gap-2 text-white/45 text-[15px] pl-1">
                <Loader2 size={15} className="animate-spin" />
                {askSettings.useThinking ? "AI 正在深度推理并查阅数据…" : "AI 正在查阅真实评论数据…"}
              </div>
            )}
          </div>
        )}
      </div>
      {/* 输入框悬浮在消息区上方：渐变遮罩 + 玻璃卡片，不再占 flex 底栏 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-4 pb-5 pt-10 bg-gradient-to-t from-[#141a27] from-35% via-[#141a27]/75 to-transparent">
        <div className="pointer-events-auto max-w-4xl mx-auto flex gap-2.5 items-end">
          <div className="flex-1 min-w-0 flex gap-2.5 items-end rounded-3xl border border-white/18 bg-[#1a2233]/72 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.55),0_0_0_1px_rgba(255,255,255,0.06)_inset] px-3.5 py-3">
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
              style={{ height: "52px" }}
              className="flex-1 resize-none min-h-[52px] bg-transparent border-0 rounded-2xl px-3.5 py-3 text-[19px] leading-relaxed text-white placeholder-white/30 outline-none transition-colors overflow-y-hidden"
            />
            <div className="flex flex-none items-center gap-2.5">
              <AskThinkingToggle
                enabled={askSettings.useThinking}
                onChange={(useThinking) => setAskSettings((s) => ({ ...s, useThinking }))}
              />
              <button
                type="button"
                onClick={chatLoading ? handleStopChat : handleSendChat}
                disabled={!chatLoading && !chatInput.trim()}
                aria-label={chatLoading ? "停止" : "发送"}
                className="flex-none h-[52px] min-w-[52px] rounded-2xl px-3 flex items-center justify-center transition-colors disabled:cursor-not-allowed bg-[#e6ecff] text-[#20325f] hover:bg-[#f0f4ff] disabled:bg-[#e6ecff]/30 disabled:text-white/35">
                {chatLoading ? <X size={16} /> : <ArrowUp size={19} strokeWidth={2.4} />}
              </button>
            </div>
          </div>
          <AskEmojiToggle
            compact
            enabled={askSettings.useEmoji}
            onChange={(useEmoji) => setAskSettings((s) => ({ ...s, useEmoji }))}
          />
        </div>
      </div>
      {showClearChatConfirm && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-[#141a27]/75 backdrop-blur-sm px-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setShowClearChatConfirm(false);
          }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-chat-title"
            className="w-full max-w-md rounded-2xl border border-white/18 bg-[#242c3d] p-5 shadow-[0_20px_50px_rgba(0,0,0,0.45)]">
            <h3 id="clear-chat-title" className="text-white/95 text-[17px] font-semibold mb-2">清空此对话？</h3>
            <p className="text-white/65 text-[14px] leading-relaxed mb-5">
              将删除「{askContextLabel}」下的全部问答记录，且无法恢复。输入框里未发送的内容会保留。
            </p>
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setShowClearChatConfirm(false)}
                className="rounded-xl px-3.5 py-2 text-[14px] text-white/75 hover:text-white/90 hover:bg-white/8 transition-colors">
                取消
              </button>
              <button
                type="button"
                onClick={handleClearChat}
                className="rounded-xl px-3.5 py-2 text-[14px] text-red-200 bg-red-500/20 hover:bg-red-500/30 border border-red-400/25 transition-colors">
                清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ── 中间区域：回复模式 ──
  const ReplyResult = (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {tagFilter && stats?.tagCounts[tagFilter] && (
        <div className="flex items-center gap-4 px-4 pt-4 flex-none">
          <DonutPercent percent={(stats.tagCounts[tagFilter].count / stats.total) * 100} size={48} />
          <div className="min-w-0">
            <p className="text-white/90 text-[15px] font-medium mb-1">{stats.tagCounts[tagFilter].label}（{stats.tagCounts[tagFilter].count}）</p>
            <TagBreakdown t={stats.tagCounts[tagFilter]} activeSubKey={subTagFilter || undefined}
              onJump={(subKey) => setSubTagFilter(subKey === subTagFilter ? undefined : subKey)} />
          </div>
        </div>
      )}
      <div className={`flex-1 overflow-y-auto px-4 ${selectedReview ? "pb-56" : "pb-4"}`}>
        <div className="sticky top-0 z-10 -mx-1 px-1 pt-3 pb-3 bg-gradient-to-b from-[#141a27] from-55% to-transparent">
          <div className="flex flex-wrap items-center gap-2.5 w-full">
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-0">
            <div className="relative flex-1 min-w-[12rem]">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
              <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setSearch(searchInput.trim())}
                placeholder="搜索评论内容/作者..."
                className={`w-full ${REPLY_FILTER_FIELD} pl-10 pr-3.5 py-2.5 text-white placeholder-white/40`} />
            </div>
            <select value={tagFilter || ""} onChange={(e) => setTagFilter(e.target.value || undefined)}
              className={`${REPLY_FILTER_FIELD} px-3.5 py-2.5 text-white/90 min-w-[10rem]`}>
              <option value="">
                全部问题类型{stats ? `（${stats.total.toLocaleString()}）` : ""}
              </option>
              {stats && Object.entries(stats.tagCounts).sort((a, b) => b[1].count - a[1].count).map(([key, t]) => (
                <option key={key} value={key}>{t.label}（{t.count}）</option>
              ))}
            </select>
            {tagFilter && stats?.tagCounts[tagFilter] && hasSubTagBreakdown(stats.tagCounts[tagFilter].subTags) && (
              <select value={subTagFilter || ""} onChange={(e) => setSubTagFilter(e.target.value || undefined)}
                className={`${REPLY_FILTER_FIELD} px-3.5 py-2.5 text-white/90 min-w-[9rem]`}>
                <option value="">全部子问题</option>
                {sortSubTagRecordForDisplay(stats.tagCounts[tagFilter].subTags).map(([key, s]) => (
                  <option key={key} value={key}>{s.label}（{s.count}）</option>
                ))}
              </select>
            )}
            <select value={repliedFilter === undefined ? "" : String(repliedFilter)}
              onChange={(e) => setRepliedFilter(e.target.value === "" ? undefined : e.target.value === "true")}
              className={`${REPLY_FILTER_FIELD} px-3.5 py-2.5 text-white/90 min-w-[9rem]`}>
              <option value="">
                全部回复状态{replyStatusCounts ? `（${replyStatusCounts.total}）` : ""}
              </option>
              <option value="true">
                已回复{replyStatusCounts ? `（${replyStatusCounts.replied}）` : ""}
              </option>
              <option value="false">
                未回复{replyStatusCounts ? `（${replyStatusCounts.unreplied}）` : ""}
              </option>
            </select>
            {search && (
              <button onClick={() => { setSearch(""); setSearchInput(""); }}
                className={`flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-[14px] text-white/90 hover:border-white/28 transition-colors ${REPLY_FILTER_FIELD}`}>
                "{search}" <X size={13} />
              </button>
            )}
            </div>
            <ReplyTranslateToggle
              enabled={translateSettings.enabled}
              onChange={(enabled) => setTranslateSettings((s) => ({ ...s, enabled }))}
            />
            <ReplyLockedToolbarButton label="审阅/批量回复" icon={ListChecks} />
            <ReplyReclassifyButton
              locked={!canReclassify}
              disabled={Boolean(reclassifyBlockedReason)}
              disabledReason={reclassifyBlockedReason || "重跑当前筛选结果的分类"}
              loading={reclassifyLoading}
              count={canReclassify && tagFilter && !reclassifyBlockedReason ? total : 0}
              onClick={handleReclassify}
            />
          </div>
        </div>
        <p className="px-1 pb-2.5 text-[13px] text-white/45 leading-snug">
          {loading && replyStatusCounts === null
            ? "正在统计评论…"
            : `共 ${total.toLocaleString()} 条评论`}
          {reclassifyFeedback && (
            <span className={reclassifyFeedback.includes("失败") || reclassifyFeedback.includes("超过") ? " text-red-400/90" : " text-[#8fb0ff]/90"}>
              {" · "}{reclassifyFeedback}
            </span>
          )}
        </p>
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
                <button key={r.id} data-review-card onClick={() => handleSelectReview(r)}
                  className={`text-left rounded-xl p-4 transition-colors ${
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

      {/* 回复详情 / AI 回复：悬浮毛玻璃，仅选中时展示 */}
      {selectedReview && (
        <div
          ref={replyDetailRef}
          className="absolute bottom-4 left-4 right-4 z-20 rounded-3xl border border-white/18 bg-white/[0.14] backdrop-blur-xl shadow-[0_20px_50px_rgba(0,0,0,0.45)] p-5 max-h-[min(52vh,420px)] overflow-y-auto">
          <div className="flex flex-col gap-3">
            {(() => {
              const display = getDisplayContent(selectedReview, translateSettings);
              return (
                <div className="rounded-xl border border-white/12 bg-white/[0.08] px-3.5 py-3">
                  <p className="text-white/60 text-[14px] mb-1">评论原文</p>
                  <p className="text-white/85 text-[16px] leading-relaxed whitespace-pre-line max-h-36 overflow-y-auto">
                    {selectedReview.content}
                  </p>
                  {display.translated && (
                    <>
                      <p className="text-white/60 text-[14px] mt-2.5 mb-1">译文</p>
                      <p className="text-white/85 text-[16px] leading-relaxed whitespace-pre-line max-h-36 overflow-y-auto">
                        {display.text}
                      </p>
                    </>
                  )}
                </div>
              );
            })()}
            {selectedReview.official_reply && (
              <div className="rounded-xl border border-white/12 bg-white/[0.08] px-3.5 py-3">
                <p className="text-white/55 text-[14px] font-medium mb-1">{appName} 官方曾这样回复（公开信息，模板化覆盖海量评论）</p>
                <p className="text-white/75 text-[16px] leading-relaxed line-clamp-2">{selectedReview.official_reply}</p>
              </div>
            )}
            <div className="rounded-xl border border-white/14 bg-white/[0.10] px-3.5 py-3">
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <p className="text-white/85 text-[15px] font-medium">呼声雷达 AI 针对这条的个性化回复建议</p>
                <button onClick={() => setSelectedReview(null)} className="text-white/35 hover:text-white/80 transition-colors"><X size={16} /></button>
              </div>
              {aiReply ? (
                <>
                  <p className="text-white/90 text-[16px] leading-relaxed whitespace-pre-line">{aiReply}</p>
                  {aiReplyTranslation && (
                    <>
                      <p className="text-white/60 text-[14px] mt-2.5 mb-1">译文（该译文不会被发送）</p>
                      <p className="text-white/85 text-[16px] leading-relaxed whitespace-pre-line">{aiReplyTranslation}</p>
                    </>
                  )}
                </>
              ) : (
                <button onClick={handleGenerateAiReply} disabled={aiLoading}
                  className="flex items-center gap-1.5 text-[15px] text-white/85 bg-white/10 hover:bg-white/15 disabled:opacity-50 px-3.5 py-2 rounded-lg transition-colors">
                  {aiLoading && <Loader2 size={14} className="animate-spin" />}
                  {aiLoading ? "生成中..." : "生成 AI 回复建议"}
                </button>
              )}
              {aiError && <p className="text-red-400 text-[14px] mt-2">{aiError}</p>}
            </div>
          </div>
        </div>
      )}
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
        <div className="p-3 flex items-center justify-between flex-none gap-2">
          <button onClick={() => setLeftOpen(false)}
            className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition-colors flex-none">
            <PanelLeft size={20} strokeWidth={1.5} />
          </button>
          <SegmentedControl<LeftSidebarView>
            value={leftSidebarView}
            onChange={setLeftSidebarView}
            className="flex-1 min-w-0"
            itemClassName="px-2.5 py-1.5 text-[13px]"
            fill
            options={[
              { value: "filter", label: "筛选" },
              { value: "settings", label: "设置", icon: <Settings size={12} /> },
            ]}
          />
        </div>
        <div className="flex-1 flex flex-col overflow-hidden">
          {leftSidebarView === "filter" && (
            <>
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
                  <div className="absolute left-3 right-3 top-full mt-1.5 z-30 bg-[#242c3d] border border-white/20 rounded-xl p-1.5 shadow-xl flex flex-col gap-0.5">
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
                <SegmentedControl<TimeRange>
                  value={timeRange}
                  onChange={setTimeRange}
                  itemClassName="px-3.5 py-1.5 text-[14px]"
                  options={[
                    { value: "week", label: "最近一周" },
                    { value: "month", label: "最近一月" },
                  ]}
                />
              </div>
            </>
          )}
          {leftSidebarView === "filter" ? (
            platform === "googleplay" ? (
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
                <p className="text-white/35 text-[12px] text-center leading-relaxed">App Store 暂不支持</p>
              </div>
            )
          ) : (
            <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col divide-y divide-white/10 text-[14px]">
              <p className="text-white/50 text-[12px] px-1 pb-4">
                当前 App：{selectedApp?.display_name ?? "未选择"}
              </p>
              <section className="py-4">
                <p className="text-white/60 uppercase tracking-wider text-[13px] font-semibold mb-2 px-1">翻译</p>
                <div className="bg-white/6 rounded-xl p-3 flex flex-col gap-3">
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
              </section>
              <section className="py-4">
                <p className="text-white/60 uppercase tracking-wider text-[13px] font-semibold mb-2 px-1">产品术语 / 专名</p>
                <p className="text-white/40 text-[12px] mb-2 px-1 leading-relaxed">
                  按 App 维护专名映射，对本 App 的翻译、问 AI、回复建议均生效。术语表为空时仍遵守「未知专名保留原文、禁止意译」。
                </p>
                <GlassHoverTooltip message={LOCKED_FEATURE_HINT} wrapClassName={`relative block ${LOCKED_SURFACE_CURSOR}`}>
                <TerminologyGlossaryEditor
                  appId={selectedAppId}
                  appName={selectedApp?.display_name ?? "当前 App"}
                  rows={terminologyDraft}
                  locked
                  onChange={setTerminologyDraft}
                  onSaved={(glossary) => {
                    setTerminologyDraft(
                      glossary.map((e) => ({
                        source: e.source ?? "",
                        zh: e.zh ?? "",
                        en: e.en ?? "",
                        note: e.note ?? "",
                      }))
                    );
                    setApps((prev) =>
                      prev.map((a) => (a.id === selectedAppId ? { ...a, terminology_glossary: glossary } : a))
                    );
                  }}
                />
                </GlassHoverTooltip>
              </section>
              <section className="py-4">
                <p className="text-white/60 uppercase tracking-wider text-[13px] font-semibold mb-2 px-1">AI 回复建议 context 设置</p>
                <p className="text-white/40 text-[12px] mb-2 px-1 leading-relaxed">仅用于「评论查看&回复」栏目的 AI 回复建议，与「问 AI」无关。</p>
                <GlassHoverTooltip message={LOCKED_FEATURE_HINT} wrapClassName={`relative block ${LOCKED_SURFACE_CURSOR}`}>
                <div className="relative bg-white/6 rounded-xl p-3 flex flex-col gap-3">
                  <div className="pointer-events-none select-none flex flex-col gap-3">
                  {([
                    ["语气", DEFAULT_AI_REPLY_SETTINGS.tone, 2],
                    ["句式", DEFAULT_AI_REPLY_SETTINGS.style, 2],
                    ["联系方式", DEFAULT_AI_REPLY_SETTINGS.contactInfo, 3],
                  ] as const).map(([label, placeholder, rows]) => (
                    <div key={label} className="flex flex-col gap-1.5">
                      <span className="text-white/55 text-[12px]">{label}</span>
                      <textarea
                        readOnly
                        tabIndex={-1}
                        value=""
                        placeholder={placeholder}
                        rows={rows}
                        className={AI_REPLY_FIELD_LOCKED_CLASS}
                      />
                    </div>
                  ))}
                  </div>
                  <div className={`absolute inset-0 z-10 ${LOCKED_SURFACE_CURSOR} rounded-xl bg-transparent`} aria-hidden />
                </div>
                </GlassHoverTooltip>
              </section>
              <section className="pt-4 pb-1">
                <p className="text-white/60 uppercase tracking-wider text-[13px] font-semibold mb-2 px-1">快捷键</p>
                <div className="bg-white/6 rounded-xl p-3 flex flex-col gap-2">
                  <ShortcutRow keys={["⌘/Ctrl", "B"]} desc="显示 / 隐藏左侧栏" />
                  {RIGHT_PANEL_NAV.map((item, i) => (
                    <ShortcutRow key={item.key} keys={["⌥/Alt", String(i + 1)]} desc={item.label} />
                  ))}
                  <ShortcutRow keys={["⌥/Alt", "T"]} desc="开关翻译（评论查看&回复栏目）" />
                </div>
                <p className="text-white/40 text-[12px] mt-2 px-1 leading-relaxed">
                  在输入框内打字时不触发，避免误操作。
                </p>
              </section>
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
          <SegmentedControl<RightPanel>
            value={activePanel}
            onChange={setActivePanel}
            className="overflow-x-auto"
            itemClassName="px-3.5 py-1.5 text-[14px]"
            options={rightPanelItems.map((item) => ({ value: item.key, label: item.label, icon: item.icon }))}
          />
        </div>
        <span className="text-white/45 text-[13px] flex-none">
          {stats ? `${stats.total} 条评论` : statsLoading ? "统计加载中…" : statsError ? "统计未就绪" : "—"}
        </span>
      </div>

      {showDataLoading ? (
        <div className="flex-1 flex items-center justify-center">
          {bootError ? (
            <InlineLoadError
              message={bootError}
              onRetry={() => {
                setBootError("");
                setBootReady(false);
                setDataRefreshKey((k) => k + 1);
              }}
            />
          ) : (
            <InlineLoading label={selectedApp ? "评论加载中…" : "App 数据加载中…"} />
          )}
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
