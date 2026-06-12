"use client";

import { useState } from "react";
import Link from "next/link";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

// ─── 模拟数据 ───────────────────────────────────────────────

const chartData = [
  { date: "1/4", rating: 4.2 },
  { date: "1/11", rating: 4.3 },
  { date: "1/18", rating: 4.1 },
  { date: "1/25", rating: 4.2 },
  { date: "2/1", rating: 3.9 },
  { date: "2/8", rating: 3.6 },
  { date: "2/15", rating: 3.4 },
  { date: "2/22", rating: 3.3 },
  { date: "3/1", rating: 3.5 },
  { date: "3/8", rating: 3.8 },
  { date: "3/15", rating: 4.2 },
  { date: "3/22", rating: 4.4 },
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
  language: "en" | "ja" | "ko";
  content: string;
  translation: string | null;
  type: "complaint" | "wishlist" | "praise";
  aiReply: string;
};

const reviews: Review[] = [
  {
    id: 1, platform: "appstore", version: "v2.0", rating: 5,
    author: "Sarah_M", date: "2024-01-08", country: "🇺🇸", language: "en",
    content: "Best travel companion app I've used. The offline maps saved me in rural Vietnam where I had zero signal. Absolutely essential for any solo traveler!",
    translation: null, type: "praise",
    aiReply: "Thank you so much for the kind words, Sarah! Offline maps for remote areas was one of our most-requested features, and we're thrilled it made your Vietnam trip smoother. Safe travels! 🌏",
  },
  {
    id: 2, platform: "appstore", version: "v2.0", rating: 4,
    author: "JetsetterKev", date: "2024-01-19", country: "🇬🇧", language: "en",
    content: "Great app overall. The hotel search is fast and the flight comparisons save me a lot of money. Would love to see train ticket booking added for Europe.",
    translation: null, type: "wishlist",
    aiReply: "Thanks for the feedback, Kev! Train booking for Europe is definitely on our roadmap — we hear this from a lot of European travelers. We'll keep you posted when it launches!",
  },
  {
    id: 3, platform: "appstore", version: "v2.1", rating: 1,
    author: "FrustratedFlyer99", date: "2024-02-05", country: "🇺🇸", language: "en",
    content: "The latest update completely BROKE the app. Battery drains to zero in under 2 hours and it crashes every single time I try to book a hotel. I had to use a competitor app for my entire trip. Uninstalling until this is fixed.",
    translation: null, type: "complaint",
    aiReply: "We're truly sorry for ruining your trip experience — this is not acceptable. v2.1 introduced a background sync bug causing the battery drain and crash issues you described. These are fully fixed in v2.2, now available in the App Store. Please update and reply here if any issues persist.",
  },
  {
    id: 4, platform: "appstore", version: "v2.1", rating: 1,
    author: "tabi_sukii", date: "2024-02-12", country: "🇯🇵", language: "ja",
    content: "v2.1にアップデートしてから電池の消耗がひどくなりました。以前は一日余裕で使えたのに、今は4時間で切れます。すぐに修正してください。",
    translation: "v2.1 にアップデートしてから電池の消耗がひどくなりました。以前は一日余裕で使えたのに、今は4時間で切れます。すぐに修正してください。→ 【中文】自从更新到 v2.1，耗电变得非常严重。以前可以用一整天，现在4小时就没电了。请尽快修复。",
    type: "complaint",
    aiReply: "この度はご不便をおかけして大変申し訳ございません。v2.1 でバックグラウンド同期の不具合が発生し、電池消耗の原因となっておりました。v2.2 で完全に修正済みです。ぜひアップデートをお試しください。",
  },
  {
    id: 5, platform: "appstore", version: "v2.1", rating: 2,
    author: "MapLover_Dan", date: "2024-02-18", country: "🇦🇺", language: "en",
    content: "Map loading used to be instant. Now it takes 5+ seconds every time. The offline mode is also broken — downloaded maps don't load at all. Two stars because the core idea is still great.",
    translation: null, type: "complaint",
    aiReply: "Hi Dan, the map loading regression in v2.1 was a critical bug we've since fixed. v2.2 restores instant loading and repairs the offline mode completely. Thanks for sticking with us — please update!",
  },
  {
    id: 6, platform: "appstore", version: "v2.1", rating: 3,
    author: "NomadNancy", date: "2024-02-25", country: "🇨🇦", language: "en",
    content: "Core features still work but the new UI is really confusing. I can't find the currency converter anymore, and the booking history is buried three menus deep. Bring back the simpler design.",
    translation: null, type: "complaint",
    aiReply: "Thanks for the detailed feedback, Nancy. You're right — we moved key features in v2.1 and the navigation became less intuitive. v2.2 restores the currency converter to the home screen and simplifies the booking history access. Hope this helps!",
  },
  {
    id: 7, platform: "appstore", version: "v2.2", rating: 5,
    author: "HappyHiker_Tom", date: "2024-03-12", country: "🇺🇸", language: "en",
    content: "v2.2 fixed EVERYTHING. Battery is back to normal, no more crashes, maps load instantly. This is the best travel app on the market when it works properly. 5 stars back!",
    translation: null, type: "praise",
    aiReply: "Tom, this made our whole team's day! We worked hard to make v2.2 right, and reviews like yours confirm we got there. Thank you for sticking with us through v2.1. Happy travels! 🎉",
  },
  {
    id: 8, platform: "appstore", version: "v2.2", rating: 4,
    author: "seoul_traveler", date: "2024-03-20", country: "🇰🇷", language: "ko",
    content: "v2.2 업데이트 후 훨씬 나아졌어요! 배터리 문제도 해결됐고 속도도 빨라졌습니다. 다음엔 기차 예매 기능도 추가해주세요.",
    translation: "【中文】v2.2 更新后好多了！电池问题解决了，速度也变快了。下次请也添加火车订票功能。",
    type: "wishlist",
    aiReply: "감사합니다! v2.2로 더 나은 경험을 드릴 수 있어 기쁩니다. 기차 예매 기능은 현재 개발 로드맵에 포함되어 있으며, 특히 아시아 노선을 우선적으로 지원할 예정입니다. 기대해 주세요!",
  },
  {
    id: 9, platform: "appstore", version: "v2.2", rating: 5,
    author: "BackpackerBelle", date: "2024-03-26", country: "🇫🇷", language: "en",
    content: "Perfect for solo travel. The hotel search with instant booking confirmation is incredible. I booked 3 hotels across Southeast Asia in under 10 minutes. Highly recommend!",
    translation: null, type: "praise",
    aiReply: "Merci, Belle! Booking three hotels in 10 minutes — that's exactly the experience we designed for. Enjoy Southeast Asia and let us know if there's anything we can improve! 🌴",
  },
  {
    id: 10, platform: "googleplay", version: "v2.0", rating: 5,
    author: "GlobalGo_Mike", date: "2024-01-14", country: "🇺🇸", language: "en",
    content: "Downloaded this before my 3-week trip through Thailand and Cambodia. It was absolutely perfect — flight tracking, hotel deals, and the best offline maps I've used. 10/10 would recommend.",
    translation: null, type: "praise",
    aiReply: "This review means a lot to us, Mike! Thailand and Cambodia are two of our most-supported regions — glad the offline maps came through. Share your photos if you get a chance! 📸",
  },
  {
    id: 11, platform: "googleplay", version: "v2.0", rating: 4,
    author: "TravelTech_Anna", date: "2024-01-22", country: "🇩🇪", language: "en",
    content: "Solid travel app. Really wish it had more offline map coverage for rural Southeast Asia — Myanmar and Laos coverage is poor. Also would love a travel expense tracker built in.",
    translation: null, type: "wishlist",
    aiReply: "Great feedback, Anna! Expanding Myanmar and Laos offline coverage is on our Q2 roadmap. The expense tracker is also highly requested — we're evaluating it for v2.3. Stay tuned!",
  },
  {
    id: 12, platform: "googleplay", version: "v2.1", rating: 1,
    author: "AngryTraveler_23", date: "2024-02-07", country: "🇺🇸", language: "en",
    content: "WHY DID YOU BREAK THE APP?? v2.1 is an absolute disaster. Crashes every time I open hotels. Battery went from fine to 30% drain per hour. I had to use Google Maps and Booking.com separately. Fix this NOW.",
    translation: null, type: "complaint",
    aiReply: "We completely understand your frustration — this is not the experience we want to deliver. v2.1 had a critical background process bug causing the crash and battery issues. v2.2 is live now with a full fix. Please update and we'd love to hear that it's working for you.",
  },
  {
    id: 13, platform: "googleplay", version: "v2.1", rating: 2,
    author: "ryoko_tabidachi", date: "2024-02-14", country: "🇯🇵", language: "ja",
    content: "v2.1からパフォーマンスが急激に悪化しました。ホテル検索が遅くて、マップが頻繁にフリーズします。以前のバージョンに戻したいです。",
    translation: "【中文】从 v2.1 开始，性能急剧下降。酒店搜索很慢，地图频繁卡死。我想回到之前的版本。",
    type: "complaint",
    aiReply: "ご不便をおかけして申し訳ございません。v2.1 のパフォーマンス問題は v2.2 で完全に解決しております。Google Play からアップデートいただければ、以前よりも快適にお使いいただけます。",
  },
  {
    id: 14, platform: "googleplay", version: "v2.1", rating: 2,
    author: "BudgetBackpacker", date: "2024-02-20", country: "🇬🇧", language: "en",
    content: "Battery usage went from totally normal to absolutely insane after the update. 30% drain per hour on a fully charged phone. Had to carry a power bank everywhere. This is unacceptable for a travel app.",
    translation: null, type: "complaint",
    aiReply: "You're right, this was unacceptable — especially for a travel app where battery life is critical. The root cause was an unoptimized background sync loop in v2.1. v2.2 reduces background battery usage by 85%. Please update!",
  },
  {
    id: 15, platform: "googleplay", version: "v2.1", rating: 3,
    author: "min_jae_travels", date: "2024-02-28", country: "🇰🇷", language: "ko",
    content: "기능 자체는 정말 좋은데 v2.1 업데이트 이후로 너무 느려졌어요. 호텔 검색할 때 10초 이상 걸리는 경우도 있고, 앱이 가끔 멈춥니다.",
    translation: "【中文】功能本身非常好，但自 v2.1 更新后变得太慢了。有时酒店搜索需要超过10秒，而且应用有时会卡住。",
    type: "complaint",
    aiReply: "불편을 드려서 정말 죄송합니다. v2.1에서 발생한 성능 저하 문제를 v2.2에서 완전히 해결했습니다. 업데이트 후 호텔 검색 속도가 v2.0보다 더 빠르게 개선되었습니다. 확인해 보세요!",
  },
  {
    id: 16, platform: "googleplay", version: "v2.2", rating: 5,
    author: "PhilTheExplorer", date: "2024-03-11", country: "🇺🇸", language: "en",
    content: "They actually listened to every complaint and fixed everything in v2.2! Battery is normal, no crashes, maps are fast again. This is how you treat your users. Respect.",
    translation: null, type: "praise",
    aiReply: "Phil, thank you — comments like this keep us going. We take every piece of feedback seriously, and v2.2 was our promise to make things right. Appreciate your patience during v2.1!",
  },
  {
    id: 17, platform: "googleplay", version: "v2.2", rating: 5,
    author: "IsabellaRoamsFree", date: "2024-03-18", country: "🇧🇷", language: "en",
    content: "Back to being the best travel app out there. v2.2 brought back all the speed and stability. The new hotel recommendation algorithm is also noticeably better. Well done team!",
    translation: null, type: "praise",
    aiReply: "Obrigada, Isabella! We did put extra work into the recommendation engine in v2.2 — thrilled you noticed. More improvements are coming in v2.3. Safe travels! 🌎",
  },
  {
    id: 18, platform: "googleplay", version: "v2.2", rating: 4,
    author: "WanderingWill_AU", date: "2024-03-25", country: "🇦🇺", language: "en",
    content: "Great recovery with v2.2. Performance is back to excellent. My one wishlist item: please add multi-currency tracking so I can log expenses in local currencies during trips.",
    translation: null, type: "wishlist",
    aiReply: "Love this idea, Will! Multi-currency expense tracking is our #3 most-requested feature right now. It's planned for v2.3 — we'll make sure to include AUD support. Thanks for the suggestion!",
  },
];

const analysisContent = {
  complaints: {
    summary: "v2.1 发布后（2月1日–3月7日），共收到 247 条差评，差评率从 12% 飙升至 47%。以下是 AI 提取的核心问题：",
    items: [
      { rank: 1, issue: "电池续航骤降", detail: "提及率 68%，用户反映 v2.1 后每小时耗电达 30%，是 v2.0 的 3 倍", icon: "🔋" },
      { rank: 2, issue: "酒店预订模块崩溃", detail: "提及率 54%，点击酒店预订页面后 App 直接闪退，影响核心功能", icon: "💥" },
      { rank: 3, issue: "地图加载极慢", detail: "提及率 41%，v2.0 即时加载退化为 5–10 秒，离线模式完全失效", icon: "🗺️" },
      { rank: 4, issue: "UI 改版令人困惑", detail: "提及率 29%，货币换算器入口被移除，常用功能藏在三级菜单", icon: "🧩" },
      { rank: 5, issue: "客服响应过慢", detail: "提及率 18%，差评高峰期用户平均等待回复超过 72 小时", icon: "📞" },
    ],
  },
  wishlist: {
    summary: "基于全量评论分析，以下是用户最强烈的功能愿望，已按提及频次排序：",
    items: [
      { rank: 1, feature: "火车票预订", count: "47 次提及", detail: "日本、欧洲、印度用户需求最强，尤其是 JR Pass 整合", icon: "🚄" },
      { rank: 2, feature: "东南亚离线地图扩展", count: "38 次提及", detail: "缅甸、老挝、柬埔寨偏远地区覆盖不足是高频投诉", icon: "🗺️" },
      { rank: 3, feature: "多货币开销追踪", count: "31 次提及", detail: "旅行者希望在 App 内直接记录各地消费，自动换算", icon: "💱" },
      { rank: 4, feature: "旅行路线社交分享", count: "24 次提及", detail: "可以生成行程卡片分享给同行朋友，协作规划路线", icon: "📤" },
      { rank: 5, feature: "目的地天气集成", count: "19 次提及", detail: "在酒店/景点页面直接显示未来7天天气", icon: "🌤️" },
    ],
  },
  comparison: {
    v21: { rating: 3.3, negative: 47, top: ["电池崩溃", "App 闪退", "地图失效"] },
    v22: { rating: 4.5, negative: 8, top: ["火车票预订", "更多地图覆盖", "开销追踪"] },
  },
  quotes: [
    {
      text: "Best travel companion app I've used. The offline maps saved me in rural Vietnam where I had zero signal. Absolutely essential for any solo traveler!",
      author: "Sarah M.", country: "🇺🇸", rating: 5, platform: "App Store",
      zh: "用过的最好的旅行伴侣 App。越南农村完全没信号时，离线地图救了我。独自旅行者必备！",
    },
    {
      text: "They actually listened to every complaint and fixed everything in v2.2! This is how you treat your users. Respect.",
      author: "PhilTheExplorer", country: "🇺🇸", rating: 5, platform: "Google Play",
      zh: "他们真的听取了每一条投诉，在 v2.2 里全部修复了！这才是对待用户该有的态度。致敬。",
    },
    {
      text: "Perfect for solo travel. The hotel search with instant booking confirmation is incredible. I booked 3 hotels across Southeast Asia in under 10 minutes.",
      author: "BackpackerBelle", country: "🇫🇷", rating: 5, platform: "App Store",
      zh: "独自旅行的完美工具。酒店搜索加即时确认太厉害了，10分钟内在东南亚预订了3家酒店。",
    },
  ],
};

// ─── 组件 ────────────────────────────────────────────────────

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-yellow-400 text-xs tracking-tight">
      {"★".repeat(rating)}{"☆".repeat(5 - rating)}
    </span>
  );
}

function PlatformTag({ platform }: { platform: "appstore" | "googleplay" }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
      platform === "appstore"
        ? "bg-blue-500/15 text-blue-400"
        : "bg-green-500/15 text-green-400"
    }`}>
      {platform === "appstore" ? " App Store" : "▶ Google Play"}
    </span>
  );
}

function VersionTag({ version }: { version: string }) {
  const colors: Record<string, string> = {
    "v2.0": "bg-gray-700 text-gray-300",
    "v2.1": "bg-red-500/20 text-red-400",
    "v2.2": "bg-emerald-500/20 text-emerald-400",
  };
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${colors[version] ?? "bg-gray-700 text-gray-300"}`}>
      {version}
    </span>
  );
}

function TypeTag({ type }: { type: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    complaint: { label: "差评", cls: "bg-red-500/10 text-red-400" },
    wishlist: { label: "愿望", cls: "bg-purple-500/10 text-purple-400" },
    praise: { label: "好评", cls: "bg-emerald-500/10 text-emerald-400" },
  };
  const t = map[type];
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${t.cls}`}>{t.label}</span>
  );
}

// ─── 主组件 ─────────────────────────────────────────────────

type Mode = "analyze" | "reply";
type Panel = "trend" | "complaints" | "wishlist" | "comparison" | "quotes";
type MobileTab = "filter" | "content" | "features";

export default function DemoPage() {
  const [mode, setMode] = useState<Mode>("analyze");
  const [activePanel, setActivePanel] = useState<Panel>("trend");
  const [selectedReview, setSelectedReview] = useState<Review | null>(null);
  const [chartType, setChartType] = useState<"line" | "heatmap">("line");
  const [timeRange, setTimeRange] = useState<"week" | "month">("month");
  const [platform, setPlatform] = useState<"all" | "appstore" | "googleplay">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "complaint" | "wishlist" | "praise">("all");
  const [chatInput, setChatInput] = useState("");
  const [submittedReplies, setSubmittedReplies] = useState<number[]>([]);
  const [showToast, setShowToast] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>("content");
  const [regionOpen, setRegionOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<{ q: string; a: string }[]>([]);

  const filteredReviews = reviews.filter((r) => {
    if (platform !== "all" && r.platform !== platform) return false;
    if (typeFilter !== "all" && r.type !== typeFilter) return false;
    return true;
  });

  function handleSelectReview(r: Review) {
    setSelectedReview(r);
    setChatInput(r.aiReply);
  }

  function handleSubmitReply() {
    if (!selectedReview) return;
    setSubmittedReplies((prev) => [...prev, selectedReview.id]);
    setShowToast(true);
    setSelectedReview(null);
    setChatInput("");
    setTimeout(() => setShowToast(false), 3000);
  }

  const presetQAs: Record<string, string> = {
    "最近差评主要集中在哪些问题？": analysisContent.complaints.items.slice(0, 3).map((i, n) => `${n + 1}. **${i.issue}**：${i.detail}`).join("\n"),
    "v2.1和v2.2有什么区别？": `v2.1 发布后评分从 4.2 跌至 3.3，差评率高达 47%，主因是电池 bug 和 App 崩溃。v2.2 修复了全部问题，评分回升至 4.5，差评率降至 8%。`,
    "用户最想要什么新功能？": analysisContent.wishlist.items.slice(0, 3).map((i, n) => `${n + 1}. **${i.feature}**（${i.count}）：${i.detail}`).join("\n"),
  };

  function handleSendChat() {
    if (!chatInput.trim()) return;
    const q = chatInput.trim();
    const a = presetQAs[q] ?? "基于当前评论数据分析：该问题涉及多个版本的用户反馈，建议重点关注 v2.1 差评集中期（2月1日–3月7日）的用户诉求，以及 v2.2 修复后的正向评价趋势。";
    setChatMessages((prev) => [...prev, { q, a }]);
    setChatInput("");
  }

  // ── Sidebar ──
  const Sidebar = (
    <div className="w-56 flex-none bg-gray-900 border-r border-white/5 flex flex-col overflow-y-auto">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-white/5">
        <Link href="/" className="flex items-center gap-1.5 text-sm font-semibold text-white">
          <span>📡</span>
          <span>呼声雷达</span>
        </Link>
        <p className="text-[11px] text-gray-500 mt-0.5">TravelMate · Demo</p>
      </div>

      {/* Mode toggle */}
      <div className="p-3">
        <div className="flex bg-gray-800 rounded-lg p-0.5">
          {(["analyze", "reply"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-all ${
                mode === m ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-white"
              }`}
            >
              {m === "analyze" ? "分析" : "回复"}
            </button>
          ))}
        </div>
      </div>

      <div className="px-3 pb-3 flex flex-col gap-3 text-xs">
        {/* Platform */}
        <div>
          <p className="text-gray-500 uppercase tracking-wider text-[10px] mb-1.5">平台</p>
          <div className="flex flex-col gap-1">
            {(["all", "appstore", "googleplay"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                className={`text-left px-2 py-1.5 rounded text-xs transition-colors ${
                  platform === p ? "bg-indigo-600/20 text-indigo-300" : "text-gray-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {p === "all" ? "全部" : p === "appstore" ? " App Store" : "▶ Google Play"}
              </button>
            ))}
          </div>
        </div>

        {/* Version */}
        <div>
          <p className="text-gray-500 uppercase tracking-wider text-[10px] mb-1.5">版本</p>
          <div className="flex flex-wrap gap-1">
            {["v2.0", "v2.1", "v2.2"].map((v) => (
              <span key={v} className={`px-2 py-0.5 rounded text-[11px] font-mono cursor-default ${
                v === "v2.1" ? "bg-red-500/20 text-red-400" : v === "v2.2" ? "bg-emerald-500/20 text-emerald-400" : "bg-gray-700 text-gray-300"
              }`}>{v}</span>
            ))}
          </div>
        </div>

        {/* Rating */}
        <div>
          <p className="text-gray-500 uppercase tracking-wider text-[10px] mb-1.5">评分</p>
          <div className="flex flex-wrap gap-1">
            {[5, 4, 3, 2, 1].map((r) => (
              <span key={r} className="text-yellow-400 text-xs cursor-default select-none">{"★".repeat(r)}</span>
            ))}
          </div>
        </div>

        {/* Region (collapsible) */}
        <div>
          <button
            onClick={() => setRegionOpen(!regionOpen)}
            className="flex items-center justify-between w-full text-gray-500 uppercase tracking-wider text-[10px] mb-1.5"
          >
            <span>地区</span>
            <span className="text-gray-600">{regionOpen ? "▲" : "▼"}</span>
          </button>
          {regionOpen && (
            <div className="flex flex-col gap-0.5">
              {["北美", "欧洲", "东南亚", "日本", "韩国", "南亚"].map((r) => (
                <span key={r} className="text-gray-500 text-[11px] px-1 py-0.5 cursor-default">{r}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // ── Right Panel ──
  const rightPanelItems: { key: Panel; label: string; icon: string }[] = [
    { key: "trend", label: "评分趋势", icon: "📊" },
    { key: "complaints", label: "Top 差评", icon: "🔥" },
    { key: "wishlist", label: "愿望清单", icon: "✨" },
    { key: "comparison", label: "版本对比", icon: "📱" },
    { key: "quotes", label: "营销金句", icon: "💬" },
  ];

  const RightPanel = (
    <div className="w-64 flex-none bg-gray-900 border-l border-white/5 p-3 flex flex-col gap-2 overflow-y-auto">
      <p className="text-[11px] text-gray-500 uppercase tracking-wider px-1 pt-1 pb-0.5">分析功能</p>
      {rightPanelItems.map((item) => (
        <button
          key={item.key}
          onClick={() => setActivePanel(item.key)}
          className={`flex items-center gap-2.5 w-full text-left px-3 py-2.5 rounded-lg text-sm transition-all ${
            activePanel === item.key
              ? "bg-indigo-600 text-white"
              : "text-gray-400 hover:text-white hover:bg-white/5"
          }`}
        >
          <span className="text-base">{item.icon}</span>
          <span className="font-medium text-xs">{item.label}</span>
          <span className="ml-auto text-gray-600">›</span>
        </button>
      ))}
    </div>
  );

  // ── Analyze Mode Main Content ──
  const AnalyzeContent = (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Controls */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400 font-medium">
            {rightPanelItems.find((i) => i.key === activePanel)?.icon}{" "}
            {rightPanelItems.find((i) => i.key === activePanel)?.label}
          </span>
        </div>
        {activePanel === "trend" && (
          <div className="flex items-center gap-2">
            <div className="flex bg-gray-800 rounded-md p-0.5">
              {(["week", "month"] as const).map((t) => (
                <button key={t} onClick={() => setTimeRange(t)}
                  className={`text-xs px-2.5 py-1 rounded transition-all ${timeRange === t ? "bg-gray-700 text-white" : "text-gray-500 hover:text-white"}`}>
                  {t === "week" ? "本周" : "本月"}
                </button>
              ))}
            </div>
            <div className="flex bg-gray-800 rounded-md p-0.5">
              {(["line", "heatmap"] as const).map((t) => (
                <button key={t} onClick={() => setChartType(t)}
                  className={`text-xs px-2.5 py-1 rounded transition-all ${chartType === t ? "bg-gray-700 text-white" : "text-gray-500 hover:text-white"}`}>
                  {t === "line" ? "折线" : "热力"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {activePanel === "trend" && (
          <div>
            <div className="flex items-baseline gap-3 mb-1">
              <span className="text-4xl font-bold text-white">4.5</span>
              <span className="text-gray-400 text-sm">当前评分</span>
              <span className="text-emerald-400 text-sm">↑ +1.2 vs v2.1最低点</span>
            </div>
            <p className="text-gray-500 text-xs mb-5">TravelMate · 2024年1月–3月 · 全平台</p>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="date" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis domain={[3, 5]} tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ background: "#1f2937", border: "1px solid #374151", borderRadius: 8, color: "#f9fafb" }}
                  formatter={(v: unknown) => [`${v} ★`, "评分"]}
                />
                <ReferenceLine x="2/1" stroke="#ef4444" strokeDasharray="4 2" label={{ value: "v2.1 发布", fill: "#ef4444", fontSize: 10, position: "top" }} />
                <ReferenceLine x="3/8" stroke="#10b981" strokeDasharray="4 2" label={{ value: "v2.2 发布", fill: "#10b981", fontSize: 10, position: "top" }} />
                <Line type="monotone" dataKey="rating" stroke="#6366f1" strokeWidth={2.5} dot={{ fill: "#6366f1", r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
            <div className="flex gap-4 mt-4 text-xs text-gray-500">
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-red-400 inline-block" /> v2.1 发布</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-emerald-400 inline-block" /> v2.2 发布</span>
              <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-indigo-400 inline-block" /> 加权评分</span>
            </div>
          </div>
        )}

        {activePanel === "complaints" && (
          <div>
            <p className="text-gray-400 text-sm mb-5 leading-relaxed">{analysisContent.complaints.summary}</p>
            <div className="flex flex-col gap-3">
              {analysisContent.complaints.items.map((item) => (
                <div key={item.rank} className="bg-gray-800 rounded-xl p-4 border border-white/5">
                  <div className="flex items-start gap-3">
                    <span className="text-xl mt-0.5">{item.icon}</span>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-gray-500">#{item.rank}</span>
                        <span className="text-sm font-semibold text-white">{item.issue}</span>
                      </div>
                      <p className="text-xs text-gray-400 leading-relaxed">{item.detail}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activePanel === "wishlist" && (
          <div>
            <p className="text-gray-400 text-sm mb-5 leading-relaxed">{analysisContent.wishlist.summary}</p>
            <div className="flex flex-col gap-3">
              {analysisContent.wishlist.items.map((item) => (
                <div key={item.rank} className="bg-gray-800 rounded-xl p-4 border border-white/5">
                  <div className="flex items-start gap-3">
                    <span className="text-xl mt-0.5">{item.icon}</span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-semibold text-white">{item.feature}</span>
                        <span className="text-xs text-indigo-400 font-medium">{item.count}</span>
                      </div>
                      <p className="text-xs text-gray-400 leading-relaxed">{item.detail}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activePanel === "comparison" && (
          <div>
            <p className="text-gray-400 text-sm mb-5">v2.1 与 v2.2 核心指标对比</p>
            <div className="grid grid-cols-2 gap-4 mb-6">
              {[
                { label: "v2.1", data: analysisContent.comparison.v21, color: "red" },
                { label: "v2.2", data: analysisContent.comparison.v22, color: "emerald" },
              ].map(({ label, data, color }) => (
                <div key={label} className={`bg-gray-800 rounded-xl p-4 border ${color === "red" ? "border-red-500/20" : "border-emerald-500/20"}`}>
                  <div className={`text-xs font-mono mb-3 ${color === "red" ? "text-red-400" : "text-emerald-400"}`}>{label}</div>
                  <div className={`text-3xl font-bold mb-1 ${color === "red" ? "text-red-400" : "text-emerald-400"}`}>
                    {data.rating} <span className="text-yellow-400 text-base">★</span>
                  </div>
                  <div className="text-xs text-gray-500 mb-3">平均评分</div>
                  <div className={`text-xl font-bold mb-1 ${color === "red" ? "text-red-400" : "text-emerald-400"}`}>{data.negative}%</div>
                  <div className="text-xs text-gray-500 mb-3">差评率</div>
                  <div className="text-xs text-gray-400">
                    <p className="text-gray-500 mb-1">主要问题</p>
                    {data.top.map((t, i) => <p key={i} className="truncate">• {t}</p>)}
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
              <p className="text-emerald-400 text-xs font-semibold mb-1">AI 结论</p>
              <p className="text-gray-300 text-xs leading-relaxed">
                v2.2 修复使评分回升 <strong>+1.2</strong>，差评率从 47% 降至 8%，恢复至历史最优水平。
                用户诉求已从"修 bug"转向"加功能"，产品可进入正向迭代阶段。
              </p>
            </div>
          </div>
        )}

        {activePanel === "quotes" && (
          <div>
            <p className="text-gray-400 text-sm mb-5">AI 从 5 星好评中提取的高质量营销金句，可直接用于社媒传播：</p>
            <div className="flex flex-col gap-4">
              {analysisContent.quotes.map((q, i) => (
                <div key={i} className="bg-gray-800 rounded-xl p-5 border border-white/5">
                  <div className="flex items-center gap-2 mb-3">
                    <Stars rating={q.rating} />
                    <span className="text-xs text-gray-500">{q.author} {q.country}</span>
                    <span className="text-xs text-gray-600">· {q.platform}</span>
                  </div>
                  <p className="text-white text-sm leading-relaxed mb-3 italic">"{q.text}"</p>
                  <div className="border-t border-white/5 pt-3">
                    <p className="text-gray-500 text-[11px] mb-1">中文参考译文</p>
                    <p className="text-gray-400 text-xs leading-relaxed">"{q.zh}"</p>
                  </div>
                  <button className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                    复制金句 →
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Chat input (analyze mode) */}
      <div className="border-t border-white/5 p-4">
        {chatMessages.length > 0 && (
          <div className="mb-3 max-h-40 overflow-y-auto flex flex-col gap-2">
            {chatMessages.map((m, i) => (
              <div key={i} className="text-xs">
                <p className="text-gray-400 mb-0.5">你：{m.q}</p>
                <p className="text-gray-300 bg-gray-800 rounded-lg px-3 py-2 leading-relaxed whitespace-pre-line">{m.a}</p>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendChat()}
            placeholder="问我关于这款 App 的任何问题..."
            className="flex-1 bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            onClick={handleSendChat}
            className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 rounded-lg transition-colors font-medium"
          >
            发送
          </button>
        </div>
        <div className="flex gap-2 mt-2 flex-wrap">
          {Object.keys(presetQAs).map((q) => (
            <button key={q} onClick={() => setChatInput(q)}
              className="text-[11px] text-gray-500 hover:text-gray-300 border border-white/5 hover:border-white/10 rounded-full px-2.5 py-1 transition-colors">
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // ── Reply Mode Main Content ──
  const ReplyContent = (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Filter tags */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5 overflow-x-auto flex-wrap">
        {(["all", "complaint", "wishlist", "praise"] as const).map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-all whitespace-nowrap ${
              typeFilter === t
                ? "bg-indigo-600 border-indigo-500 text-white"
                : "border-white/10 text-gray-400 hover:text-white hover:border-white/20"
            }`}>
            {t === "all" ? "全部" : t === "complaint" ? "🔥 差评" : t === "wishlist" ? "✨ 愿望" : "⭐ 好评"}
          </button>
        ))}
        <span className="text-xs text-gray-600 ml-2">{filteredReviews.length} 条</span>
      </div>

      {/* Review grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filteredReviews.map((r) => {
            const isSelected = selectedReview?.id === r.id;
            const isSubmitted = submittedReplies.includes(r.id);
            return (
              <button
                key={r.id}
                onClick={() => handleSelectReview(r)}
                className={`text-left rounded-xl border p-4 transition-all ${
                  isSubmitted
                    ? "border-emerald-500/30 bg-emerald-500/5 opacity-60"
                    : isSelected
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-white/5 bg-gray-800 hover:border-white/15 hover:bg-gray-750"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <Stars rating={r.rating} />
                    <span className="text-gray-500 text-xs">{r.country}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <PlatformTag platform={r.platform} />
                    <VersionTag version={r.version} />
                  </div>
                </div>

                <p className="text-xs text-gray-300 leading-relaxed line-clamp-3 mb-2">
                  {r.content}
                </p>

                {r.translation && (
                  <p className="text-[11px] text-gray-500 leading-relaxed line-clamp-2 border-t border-white/5 pt-2">
                    {r.translation.replace("【中文】", "")}
                  </p>
                )}

                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-1.5">
                    <TypeTag type={r.type} />
                    <span className="text-[10px] text-gray-600">{r.date}</span>
                  </div>
                  {isSubmitted && <span className="text-[10px] text-emerald-400">✓ 已回复</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Reply input */}
      <div className="border-t border-white/5 p-4">
        {selectedReview && (
          <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-lg px-3 py-2 mb-3 flex items-start justify-between gap-2">
            <div>
              <p className="text-[11px] text-indigo-400 mb-0.5">AI 回复建议 · {selectedReview.author} {selectedReview.country}</p>
              <p className="text-xs text-gray-300 leading-relaxed line-clamp-2">{selectedReview.aiReply}</p>
            </div>
            <button onClick={() => { setSelectedReview(null); setChatInput(""); }} className="text-gray-600 hover:text-gray-400 text-xs flex-none">✕</button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder={selectedReview ? "编辑回复内容..." : "点击评论卡片查看 AI 回复建议"}
            className="flex-1 bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 outline-none focus:border-indigo-500 transition-colors"
          />
          <button
            onClick={handleSubmitReply}
            disabled={!selectedReview}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white text-sm px-4 rounded-lg transition-colors font-medium whitespace-nowrap"
          >
            提交回复
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-white font-[family-name:var(--font-geist)] overflow-hidden">
      {/* Toast */}
      {showToast && (
        <div className="fixed top-4 right-4 z-50 bg-emerald-600 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg flex items-center gap-2 animate-in">
          <span>✓</span>
          <span>回复已提交成功</span>
        </div>
      )}

      {/* Desktop layout */}
      <div className="hidden md:flex flex-1 overflow-hidden">
        {Sidebar}
        <main className="flex-1 flex overflow-hidden">
          {mode === "analyze" ? AnalyzeContent : ReplyContent}
        </main>
        {mode === "analyze" && RightPanel}
      </div>

      {/* Mobile layout */}
      <div className="flex md:hidden flex-1 flex-col overflow-hidden">
        {/* Mobile content */}
        <div className="flex-1 overflow-hidden">
          {mobileTab === "filter" && (
            <div className="p-4 overflow-y-auto h-full">
              <div className="flex bg-gray-800 rounded-lg p-0.5 mb-4">
                {(["analyze", "reply"] as Mode[]).map((m) => (
                  <button key={m} onClick={() => setMode(m)}
                    className={`flex-1 text-xs py-2 rounded-md font-medium transition-all ${mode === m ? "bg-indigo-600 text-white" : "text-gray-400"}`}>
                    {m === "analyze" ? "分析" : "回复"}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-4 text-xs">
                <div>
                  <p className="text-gray-500 uppercase tracking-wider text-[10px] mb-2">平台</p>
                  {(["all", "appstore", "googleplay"] as const).map((p) => (
                    <button key={p} onClick={() => setPlatform(p)}
                      className={`block w-full text-left px-3 py-2 rounded mb-1 ${platform === p ? "bg-indigo-600/20 text-indigo-300" : "text-gray-400"}`}>
                      {p === "all" ? "全部" : p === "appstore" ? " App Store" : "▶ Google Play"}
                    </button>
                  ))}
                </div>
                <div>
                  <p className="text-gray-500 uppercase tracking-wider text-[10px] mb-2">版本</p>
                  <div className="flex gap-2">
                    {["v2.0", "v2.1", "v2.2"].map((v) => (
                      <span key={v} className={`px-3 py-1 rounded font-mono text-xs ${v === "v2.1" ? "bg-red-500/20 text-red-400" : v === "v2.2" ? "bg-emerald-500/20 text-emerald-400" : "bg-gray-700 text-gray-300"}`}>{v}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
          {mobileTab === "content" && (
            <div className="flex flex-col h-full overflow-hidden">
              {mode === "analyze" ? AnalyzeContent : ReplyContent}
            </div>
          )}
          {mobileTab === "features" && mode === "analyze" && (
            <div className="p-4 overflow-y-auto h-full">
              <p className="text-xs text-gray-500 mb-3">选择分析维度</p>
              {rightPanelItems.map((item) => (
                <button key={item.key} onClick={() => { setActivePanel(item.key); setMobileTab("content"); }}
                  className={`flex items-center gap-3 w-full text-left px-3 py-3 rounded-lg mb-2 text-sm ${activePanel === item.key ? "bg-indigo-600 text-white" : "text-gray-300 bg-gray-800"}`}>
                  <span>{item.icon}</span>
                  <span>{item.label}</span>
                  <span className="ml-auto">›</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mobile bottom tabs */}
        <div className="border-t border-white/10 bg-gray-900 flex">
          {(["filter", "content", "features"] as MobileTab[]).map((tab) => {
            const labels: Record<MobileTab, string> = { filter: "筛选", content: "内容", features: "功能" };
            const icons: Record<MobileTab, string> = { filter: "⚙️", content: "📄", features: "✨" };
            return (
              <button key={tab} onClick={() => setMobileTab(tab)}
                className={`flex-1 flex flex-col items-center py-2.5 gap-0.5 text-xs transition-colors ${mobileTab === tab ? "text-indigo-400" : "text-gray-500"}`}>
                <span className="text-base">{icons[tab]}</span>
                <span>{labels[tab]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
