"use client";

import { useState } from "react";
import Link from "next/link";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from "recharts";
import {
  ChevronLeft, ChevronRight, Store, Play, MapPin, Layers,
  TrendingDown, GitCompare, ListTodo, MessageSquare, Reply,
  Send, X, BarChart2, ChevronUp, PanelLeft, PanelRight,
} from "lucide-react";

// ─── 数据 ────────────────────────────────────────────────────

const chartData = [
  { date: "1/4", rating: 4.2 }, { date: "1/11", rating: 4.3 },
  { date: "1/18", rating: 4.1 }, { date: "1/25", rating: 4.2 },
  { date: "2/1", rating: 3.9 }, { date: "2/8", rating: 3.6 },
  { date: "2/15", rating: 3.4 }, { date: "2/22", rating: 3.3 },
  { date: "3/1", rating: 3.5 }, { date: "3/8", rating: 3.8 },
  { date: "3/15", rating: 4.2 }, { date: "3/22", rating: 4.4 },
  { date: "3/29", rating: 4.5 },
];

type Review = {
  id: number;
  platform: "appstore" | "googleplay";
  version: "v2.0" | "v2.1" | "v2.2";
  rating: 1 | 2 | 3 | 4 | 5;
  author: string;
  date: string;
  country: string;
  content: string;
  translation: string | null;
  type: "complaint" | "wishlist" | "praise";
  aiReply: string;
};

const reviews: Review[] = [
  {
    id: 1, platform: "appstore", version: "v2.1", rating: 1,
    author: "FrustratedFlyer99", date: "2024-02-05", country: "🇺🇸",
    content: "The latest update completely BROKE the app. Battery drains to zero in under 2 hours and it crashes every time I try to book a hotel.",
    translation: null, type: "complaint",
    aiReply: "We're truly sorry — this is not acceptable. v2.1 introduced a background sync bug causing the battery drain and crash issues. These are fully fixed in v2.2, now available in the App Store.",
  },
  {
    id: 2, platform: "appstore", version: "v2.2", rating: 5,
    author: "HappyHiker_Tom", date: "2024-03-12", country: "🇺🇸",
    content: "v2.2 fixed EVERYTHING. Battery is back to normal, no more crashes, maps load instantly. This is the best travel app on the market. 5 stars back!",
    translation: null, type: "praise",
    aiReply: "Tom, this made our whole team's day! We worked hard to make v2.2 right. Thank you for sticking with us through v2.1. Happy travels!",
  },
  {
    id: 3, platform: "googleplay", version: "v2.1", rating: 2,
    author: "tabi_sukii", date: "2024-02-12", country: "🇯🇵",
    content: "v2.1にアップデートしてから電池の消耗がひどくなりました。以前は一日余裕で使えたのに、今は4時間で切れます。",
    translation: "自从更新到 v2.1，耗电变得非常严重。以前可以用一整天，现在4小时就没电了。请尽快修复。",
    type: "complaint",
    aiReply: "この度はご不便をおかけして大変申し訳ございません。v2.2 で完全に修正済みです。ぜひアップデートをお試しください。",
  },
];

const complaintsData = [
  { rank: 1, issue: "电池续航骤降", detail: "提及率 68%，v2.1 后每小时耗电达 30%，是 v2.0 的 3 倍" },
  { rank: 2, issue: "酒店预订模块崩溃", detail: "提及率 54%，点击酒店预订后 App 直接闪退，影响核心功能" },
  { rank: 3, issue: "地图加载极慢", detail: "提及率 41%，v2.0 即时加载退化为 5–10 秒，离线模式失效" },
  { rank: 4, issue: "UI 改版令人困惑", detail: "提及率 29%，货币换算器入口被移除，常用功能藏在三级菜单" },
];

const wishlistData = [
  { rank: 1, feature: "火车票预订", count: "47 次提及", detail: "日本、欧洲用户需求最强，尤其是 JR Pass 整合" },
  { rank: 2, feature: "东南亚离线地图扩展", count: "38 次提及", detail: "缅甸、老挝、柬埔寨偏远地区覆盖不足" },
  { rank: 3, feature: "多货币开销追踪", count: "31 次提及", detail: "旅行者希望在 App 内直接记录各地消费，自动换算" },
];

const presetQAs: Record<string, string> = {
  "最近差评主要集中在哪些问题？": "1. **电池续航骤降**：提及率 68%\n2. **酒店预订崩溃**：提及率 54%\n3. **地图加载极慢**：提及率 41%",
  "v2.1 和 v2.2 有什么区别？": "v2.1 发布后评分从 4.2 跌至 3.3，差评率高达 47%。v2.2 修复全部问题，评分回升至 4.5，差评率降至 8%。",
  "用户最想要什么新功能？": "1. **火车票预订**（47 次提及）\n2. **东南亚离线地图**（38 次）\n3. **多货币开销追踪**（31 次）",
};

// ─── 类型 ────────────────────────────────────────────────────

type RightPanel = "complaints" | "comparison" | "wishlist" | "reply";
type MobileTab = "filter" | "analyze" | "feature";
type Platform = "all" | "appstore" | "googleplay";
type Version = "all" | "v2.0" | "v2.1" | "v2.2";

// ─── 子组件 ──────────────────────────────────────────────────

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-yellow-400 text-[14px] tracking-tight">
      {"★".repeat(rating)}{"☆".repeat(5 - rating)}
    </span>
  );
}

function GlassPanel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#181a1f] ${className}`}>
      {children}
    </div>
  );
}

// ─── 主组件 ─────────────────────────────────────────────────

export default function DemoPage() {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<RightPanel>("complaints");
  const [platform, setPlatform] = useState<Platform>("all");
  const [version, setVersion] = useState<Version>("all");
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<{ q: string; a: string }[]>([]);
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [replyInput, setReplyInput] = useState("");
  const [submittedReplies, setSubmittedReplies] = useState<number[]>([]);
  const [showToast, setShowToast] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("analyze");

  const isReplyMode = activePanel === "reply";

  function handleSendChat() {
    const q = chatInput.trim();
    if (!q) return;
    const a = presetQAs[q] ?? "基于当前评论数据分析：建议重点关注 v2.1 差评集中期（2月1日–3月7日）的用户诉求，以及 v2.2 修复后的正向评价趋势。";
    setChatMessages((prev) => [...prev, { q, a }]);
    setChatInput("");
  }

  function handleSelectReview(r: Review) {
    setSelectedReview(r);
    setReplyInput(r.aiReply);
  }

  function handleSubmitReply() {
    if (!selectedReview) return;
    setSubmittedReplies((prev) => [...prev, selectedReview.id]);
    setShowToast(true);
    setSelectedReview(null);
    setReplyInput("");
    setTimeout(() => setShowToast(false), 3000);
  }

  const filteredReviews = reviews.filter((r) => {
    if (platform !== "all" && r.platform !== platform) return false;
    if (version !== "all" && r.version !== version) return false;
    return true;
  });

  const rightPanelItems: { key: RightPanel; label: string; icon: React.ReactNode }[] = [
    { key: "complaints", label: "Top 抱怨", icon: <TrendingDown size={14} /> },
    { key: "comparison", label: "版本分析", icon: <GitCompare size={14} /> },
    { key: "wishlist", label: "愿望清单", icon: <ListTodo size={14} /> },
    { key: "reply", label: "评论回复", icon: <Reply size={14} /> },
  ];

  // ── 中间区域：分析结果 ──
  const AnalyzeResult = (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      {activePanel === "complaints" && (
        <div>
          <p className="text-white/65 text-[14px] mb-4">v2.1 发布后共收到 247 条差评，差评率从 12% 飙升至 47%。AI 提取核心问题：</p>
          <div className="flex flex-col gap-3">
            {complaintsData.map((item) => (
              <div key={item.rank} className="bg-[#1e2026] rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-white/45 text-[14px] font-mono">#{item.rank}</span>
                  <span className="text-white/90 text-[16px] font-medium">{item.issue}</span>
                </div>
                <p className="text-white/65 text-[14px] leading-relaxed">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {activePanel === "comparison" && (
        <div>
          <div className="flex items-baseline gap-3 mb-1">
            <span className="text-[42px] font-bold text-white">4.5</span>
            <span className="text-white/55 text-[16px]">当前评分</span>
            <span className="text-emerald-400 text-[16px]">↑ +1.2 vs 最低点</span>
          </div>
          <p className="text-white/45 text-[14px] mb-5">TravelMate · 2024年1月–3月 · 全平台</p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
              <XAxis dataKey="date" tick={{ fill: "#ffffff40", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis domain={[3, 5]} tick={{ fill: "#ffffff40", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#1a1a1a", border: "1px solid #ffffff15", borderRadius: 8, color: "#fff" }} formatter={(v: unknown) => [`${v} ★`, "评分"]} />
              <ReferenceLine x="2/1" stroke="#ef4444" strokeDasharray="4 2" label={{ value: "v2.1", fill: "#ef4444", fontSize: 10, position: "top" }} />
              <ReferenceLine x="3/8" stroke="#10b981" strokeDasharray="4 2" label={{ value: "v2.2", fill: "#10b981", fontSize: 10, position: "top" }} />
              <Line type="monotone" dataKey="rating" stroke="#8b5cf6" strokeWidth={2} dot={{ fill: "#8b5cf6", r: 3 }} activeDot={{ r: 5 }} />
            </LineChart>
          </ResponsiveContainer>
          <div className="grid grid-cols-2 gap-3 mt-5 mb-4">
            {[
              { label: "v2.1", rating: 3.3, negative: 47, color: "red" },
              { label: "v2.2", rating: 4.5, negative: 8, color: "emerald" },
            ].map(({ label, rating, negative, color }) => (
              <div key={label} className={`bg-[#1e2026] rounded-xl p-4 border-l-2 ${color === "red" ? "border-red-500/60" : "border-emerald-500/60"}`}>
                <div className={`text-[14px] font-mono mb-2 ${color === "red" ? "text-red-400" : "text-emerald-400"}`}>{label}</div>
                <div className={`text-[28px] font-bold mb-0.5 ${color === "red" ? "text-red-400" : "text-emerald-400"}`}>{rating} <span className="text-yellow-400 text-[14px]">★</span></div>
                <div className="text-white/45 text-[13px] mb-2">平均评分</div>
                <div className={`text-lg font-bold mb-0.5 ${color === "red" ? "text-red-400" : "text-emerald-400"}`}>{negative}%</div>
                <div className="text-white/45 text-[13px]">差评率</div>
              </div>
            ))}
          </div>
          <div className="bg-emerald-950/30 rounded-xl p-4">
            <p className="text-emerald-400 text-[14px] font-medium mb-1">AI 结论</p>
            <p className="text-white/70 text-[14px] leading-relaxed">v2.2 修复使评分回升 +1.2，差评率从 47% 降至 8%。用户诉求已从「修 bug」转向「加功能」，产品可进入正向迭代阶段。</p>
          </div>
        </div>
      )}

      {activePanel === "wishlist" && (
        <div>
          <p className="text-white/65 text-[14px] mb-4">基于全量评论分析，用户最强烈的功能愿望：</p>
          <div className="flex flex-col gap-3">
            {wishlistData.map((item) => (
              <div key={item.rank} className="bg-[#1e2026] rounded-xl p-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white/90 text-[16px] font-medium">{item.feature}</span>
                  <span className="text-white/70 text-[14px]">{item.count}</span>
                </div>
                <p className="text-white/65 text-[14px] leading-relaxed">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );

  // ── 中间区域：回复模式 ──
  const ReplyResult = (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex gap-2 px-4 pt-4 pb-2 flex-none">
        {(["all", "v2.0", "v2.1", "v2.2"] as Version[]).map((v) => (
          <button key={v} onClick={() => setVersion(v)}
            className={`px-3 py-1 rounded-full text-[13px] font-mono transition-colors ${version === v ? "bg-white/15 text-white/90" : "text-white/45 hover:text-white/70 hover:bg-white/8"}`}>
            {v === "all" ? "全部" : v}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredReviews.map((r) => {
            const isSelected = selectedReview?.id === r.id;
            const isSubmitted = submittedReplies.includes(r.id);
            return (
              <button key={r.id} onClick={() => handleSelectReview(r)}
                className={`text-left rounded-xl p-4 transition-all ${
                  isSubmitted ? "bg-emerald-950/20 opacity-50"
                  : isSelected ? "ring-1 ring-white/25 bg-white/12"
                  : "bg-[#1e2026] hover:bg-white/10"
                }`}>
                <div className="flex items-center justify-between mb-2">
                  <Stars rating={r.rating} />
                  <div className="flex items-center gap-1.5">
                    <span className="text-white/45 text-[12px]">{r.country}</span>
                    <span className={`text-[12px] px-1.5 py-0.5 rounded font-mono ${
                      r.version === "v2.1" ? "bg-red-950/50 text-red-400" : r.version === "v2.2" ? "bg-emerald-950/50 text-emerald-400" : "bg-[#2a2c32] text-white/55"
                    }`}>{r.version}</span>
                  </div>
                </div>
                <p className="text-white/70 text-[14px] leading-relaxed line-clamp-3 mb-2">{r.content}</p>
                {r.translation && (
                  <p className="text-white/55 text-[13px] leading-relaxed line-clamp-2 border-t border-white/5 pt-2">{r.translation}</p>
                )}
                <div className="flex items-center justify-between mt-2">
                  <span className="text-white/45 text-[12px]">{r.date}</span>
                  {isSubmitted && <span className="text-emerald-400 text-[12px]">已回复</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 回复输入 */}
      <div className="border-t border-white/14 p-4">
        {selectedReview && (
          <div className="bg-white/8 rounded-lg px-3 py-2 mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-white/70 text-[13px] mb-0.5">AI 回复建议 · {selectedReview.author} {selectedReview.country}</p>
              <p className="text-white/60 text-[14px] leading-relaxed line-clamp-2">{selectedReview.aiReply}</p>
            </div>
            <button onClick={() => { setSelectedReview(null); setReplyInput(""); }} className="text-white/20 hover:text-white/65 transition-colors">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <input type="text" value={replyInput} onChange={(e) => setReplyInput(e.target.value)}
            placeholder={selectedReview ? "编辑回复内容..." : "点击评论卡片查看 AI 回复建议"}
            className="flex-1 bg-[#1e2026] border border-white/14 rounded-lg px-3 py-2 text-[16px] text-white placeholder-white/25 outline-none focus:border-white/30 transition-colors" />
          <button onClick={handleSubmitReply} disabled={!selectedReview}
            className="bg-[rgb(55,57,62)] hover:bg-[rgb(75,78,84)] disabled:opacity-25 disabled:cursor-not-allowed text-white text-[16px] px-4 rounded-lg transition-colors font-medium flex items-center gap-1.5">
            <Send size={13} />
            提交
          </button>
        </div>
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
        {/* 始终渲染 toggle 行，内容 fade */}
        <div className="px-3 pb-2.5 pt-2.5 flex items-center justify-between border-b border-white/14 flex-none">
          <button onClick={() => setLeftOpen(!leftOpen)}
            className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition-colors flex-none">
            <PanelLeft size={20} strokeWidth={1.5} />
          </button>
          <span className={`text-white/65 text-[13px] font-medium transition-opacity duration-150 ${leftOpen ? "opacity-100" : "opacity-0"}`}>筛选</span>
        </div>
        <div className={`flex-1 flex flex-col overflow-hidden transition-opacity duration-150 ${leftOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
          <div className="py-2 flex items-center justify-center gap-3">
            <button onClick={() => setPlatform(platform === "appstore" ? "all" : "appstore")}
              className={`p-2.5 rounded-xl transition-colors ${platform === "appstore" ? "bg-white/12" : "hover:bg-white/10"}`}>
              <img src="/App_Store_(iOS).svg.png" alt="App Store" className={`w-7 h-7 transition-opacity ${platform === "appstore" ? "opacity-100" : "opacity-75"}`} />
            </button>
            <button onClick={() => setPlatform(platform === "googleplay" ? "all" : "googleplay")}
              className={`p-2.5 rounded-xl transition-colors ${platform === "googleplay" ? "bg-white/12" : "hover:bg-white/10"}`}>
              <img src="/Google_Play_2022_icon.svg.png" alt="Google Play" className={`w-7 h-7 transition-opacity ${platform === "googleplay" ? "opacity-100" : "opacity-75"}`} />
            </button>
          </div>
          <div className="border-t border-white/10" />
          <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4 text-[14px]">
            <div>
              <p className="text-white/35 uppercase tracking-wider text-[12px] mb-1.5 px-1">地区</p>
              {["北美", "欧洲", "东南亚", "日本", "韩国"].map((r) => (
                <button key={r} className="flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-lg text-white/55 hover:text-white/70 hover:bg-white/10 transition-colors">
                  <MapPin size={12} />
                  <span>{r}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </GlassPanel>
    </div>
  );

  // ── 右栏 ──
  const RightPanel = (
    <GlassPanel className={`flex-none flex flex-col overflow-hidden rounded-2xl transition-[width] duration-200 ease-in-out ${rightOpen ? "w-48" : "w-12"}`}>
      {/* 始终渲染 header 行 */}
      <div className="px-3 pt-3 pb-2.5 border-b border-white/14 flex items-center justify-between flex-none">
        <span className={`text-white/55 text-[13px] uppercase tracking-wider whitespace-nowrap overflow-hidden transition-all duration-150 ${rightOpen ? "opacity-100 max-w-[100px]" : "opacity-0 max-w-0"}`}>功能</span>
        <button onClick={() => setRightOpen(!rightOpen)}
          className="text-white/80 hover:text-white p-1.5 rounded-xl hover:bg-white/10 transition-colors flex-none">
          <PanelRight size={20} strokeWidth={1.5} />
        </button>
      </div>
      <div className={`flex-1 overflow-y-auto p-2 flex flex-col gap-2 transition-opacity duration-150 ${rightOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
        <div className="bg-[#1e2026] rounded-xl p-1.5 flex flex-col gap-0.5">
          {rightPanelItems.filter(i => i.key !== "reply").map((item) => (
            <button key={item.key} onClick={() => setActivePanel(item.key)}
              className={`flex items-center gap-2.5 w-full text-left px-3 py-2.5 rounded-lg text-[14px] transition-colors ${
                activePanel === item.key ? "bg-white/12 text-white/90" : "text-white/55 hover:text-white/70 hover:bg-white/10"
              }`}>
              {item.icon}
              <span className="font-medium">{item.label}</span>
            </button>
          ))}
        </div>
        {rightPanelItems.filter(i => i.key === "reply").map((item) => (
          <button key={item.key} onClick={() => setActivePanel(item.key)}
            className={`flex items-center gap-2.5 w-full text-left px-3 py-2.5 rounded-xl text-[14px] transition-colors ${
              activePanel === item.key ? "bg-white/12 text-white/90" : "text-white/55 hover:text-white/70 hover:bg-white/10"
            }`}>
            {item.icon}
            <span className="font-medium">{item.label}</span>
          </button>
        ))}
      </div>
    </GlassPanel>
  );

  // ── 中栏 ──
  const CenterPanel = (
    <GlassPanel className="flex-1 flex flex-col overflow-hidden rounded-2xl min-w-0">
      {/* 顶部标题栏 */}
      <div className="px-5 py-3 border-b border-white/14 flex items-center justify-between flex-none">
        <div className="flex items-center gap-2">
          <span className="text-white/90 text-[16px] font-medium">
            {rightPanelItems.find(i => i.key === activePanel)?.label}
          </span>
          {isReplyMode && (
            <span className="text-[12px] text-white/60 border border-white/20 rounded-full px-2 py-0.5">回复模式</span>
          )}
        </div>
        <span className="text-white/35 text-[14px]">{filteredReviews.length} 条评论</span>
      </div>

      {/* 内容区 */}
      {isReplyMode ? ReplyResult : AnalyzeResult}

      {/* Chat 输入（非回复模式） */}
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

      {/* Toast */}
      {showToast && (
        <div className="fixed top-4 right-4 z-50 bg-emerald-900/80 border border-emerald-500/30 text-emerald-300 text-[16px] px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-2">
          <span className="text-emerald-400">✓</span>
          回复已提交
        </div>
      )}

      {/* 桌面布局 */}
      <div className="hidden md:flex flex-1 overflow-hidden p-3 gap-3">
        {LeftPanel}
        {CenterPanel}
        {RightPanel}
      </div>

      {/* 手机布局 */}
      <div className="flex md:hidden flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-hidden p-3">
          {mobileTab === "filter" && (
            <GlassPanel className="h-full rounded-2xl overflow-y-auto p-4">
              <p className="text-white/55 text-[14px] uppercase tracking-wider mb-4">筛选条件</p>
              <div className="flex flex-col gap-5">
                <div>
                  <p className="text-white/35 text-[12px] uppercase tracking-wider mb-2">平台</p>
                  {(["all", "appstore", "googleplay"] as Platform[]).map((p) => (
                    <button key={p} onClick={() => setPlatform(p)}
                      className={`flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg mb-1 text-[16px] transition-colors ${platform === p ? "bg-white/12 text-white/90" : "text-white/65 hover:bg-white/10"}`}>
                      {p === "all" ? "全部" : p === "appstore" ? "App Store" : "Google Play"}
                    </button>
                  ))}
                </div>
                <div>
                  <p className="text-white/35 text-[12px] uppercase tracking-wider mb-2">地区</p>
                  {["北美", "欧洲", "东南亚", "日本", "韩国"].map((r) => (
                    <button key={r} className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg mb-1 text-[16px] text-white/65 hover:bg-white/10 transition-colors">
                      <MapPin size={13} />{r}
                    </button>
                  ))}
                </div>
              </div>
            </GlassPanel>
          )}

          {mobileTab === "analyze" && CenterPanel}

          {mobileTab === "feature" && (
            <GlassPanel className="h-full rounded-2xl overflow-y-auto p-3">
              <p className="text-white/55 text-[14px] uppercase tracking-wider mb-3 px-1">功能</p>
              <div className="flex flex-col gap-1">
                {rightPanelItems.map((item) => (
                  <button key={item.key}
                    onClick={() => { setActivePanel(item.key); setMobileTab("analyze"); }}
                    className={`flex items-center gap-3 w-full text-left px-4 py-3.5 rounded-xl text-[16px] transition-colors ${
                      activePanel === item.key ? "bg-white/12 text-white/90" : "text-white/65 hover:bg-white/10"
                    }`}>
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </GlassPanel>
          )}
        </div>

        {/* 底部 Tab */}
        <div className="bg-[#181a1f] border-t border-white/10 flex">
          {([
            { key: "filter", label: "筛选", icon: <Layers size={18} /> },
            { key: "analyze", label: "分析", icon: <BarChart2 size={18} /> },
            { key: "feature", label: "功能", icon: <ListTodo size={18} /> },
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
