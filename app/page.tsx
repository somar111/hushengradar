import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-[rgb(254,252,246)] text-gray-900 font-[family-name:var(--font-geist)]">
      {/* Nav */}
      <nav className="fixed top-4 left-1/2 -translate-x-1/2 z-10 flex items-center justify-between px-6 py-2.5 rounded-full bg-[rgb(227,227,226)]/80 backdrop-blur-md border border-gray-300/50 shadow-sm w-[90%] max-w-3xl">
        <span className="text-3xl tracking-tight" style={{ fontFamily: "'smiley-sans', sans-serif" }}>呼声雷达</span>
        <div className="flex items-center gap-2">
          <a href="/demo" className="text-base font-medium text-white bg-gray-900 hover:bg-gray-700 px-6 py-2.5 rounded-full transition-colors">查看 Demo ↗</a>
        </div>
      </nav>

      {/* Hero */}
      <main className="flex flex-col items-center justify-center px-8 pt-40 pb-12 text-center">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 leading-[1.2]">
            App 开发者的
            <br />
            <span className="text-violet-600/75">AI 评论交互中枢</span>
          </h1>

          <div className="flex items-center justify-center gap-3 mb-6 text-gray-500">
            <span className="text-sm">支持</span>
            <img src="/App_Store_(iOS).svg.png" alt="App Store" className="w-7 h-7"/>
            <img src="/Google_Play_2022_icon.svg.png" alt="Google Play" className="w-7 h-7"/>
          </div>
          <p className="text-base text-gray-500 mb-8 max-w-lg mx-auto leading-relaxed">
            AI 深度分析差评趋势，自动生成多语言回复建议
            <br />
            一个界面，告别平台切换
          </p>
          <div className="flex flex-col items-center justify-center gap-3 mb-12">
            <a href="/demo" className="text-base font-medium text-white bg-gray-900 hover:bg-gray-700 px-6 py-2.5 rounded-full transition-colors">查看 Demo ↗</a>
            <a href="/about" className="text-base text-gray-600 hover:text-gray-900 px-6 py-2.5 rounded-full bg-black/8 hover:bg-black/12 transition-colors">关于本项目</a>
          </div>

        </div>
      </main>

      {/* Features */}
      <section className="px-8 pb-20 max-w-4xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <FeatureCard
            title="官方渠道接入"
            desc="App Store Connect API + Google Cloud 服务账号，通过官方渠道获取数据，安全合规，无需爬虫"
          />
          <FeatureCard
            title="AI 深度分析"
            desc="自动提取 Top 差评问题、功能愿望清单，版本对比分析，以及问 AI 关于评论区的任何问题！"
          />
          <FeatureCard
            title="多语言查看与回复"
            desc="自带 AI 多语言翻译，AI 生成多语言回复建议，在同一界面查看、一键回复，无需切换平台"
          />
          <FeatureCard
            title="更多功能"
            desc="恶评监控、周报、自定义预警通知..."
          />
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="bg-violet-50/60 backdrop-blur-md border border-violet-100/70 rounded-xl p-6 shadow-sm">
      <h3 className="font-semibold text-gray-900 mb-2 text-base">{title}</h3>
      <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
    </div>
  );
}
