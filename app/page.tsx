import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-[rgb(254,252,246)] text-gray-900 font-[family-name:var(--font-geist)]">
      {/* Nav */}
      <nav className="fixed top-4 left-1/2 -translate-x-1/2 z-10 flex items-center justify-between px-6 py-2.5 rounded-full bg-[rgb(227,227,226)]/60 backdrop-blur-md border border-gray-300/50 shadow-sm w-[90%] max-w-3xl">
        <span className="text-3xl tracking-tight" style={{ fontFamily: "'smiley-sans', sans-serif" }}>呼声雷达</span>
        <a href="/demo" className="text-base font-medium text-white bg-gray-900 hover:bg-gray-700 px-6 py-2.5 rounded-full transition-colors">查看 Demo ↗</a>
      </nav>

      {/* Hero */}
      <main className="flex flex-col items-center justify-center px-8 pt-40 pb-12 text-center">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6 leading-[1.4]">
            App 开发者们：
          </h1>
          <blockquote className="border-l-4 border-violet-400/60 pl-4 mb-6 text-left">
            <p className="text-2xl sm:text-3xl font-bold text-violet-600/75 leading-snug">用户的声音，不该这么难听见</p>
            <p className="text-2xl sm:text-3xl font-bold text-violet-600/75 leading-snug mt-1">查看、汇总、回复——一个地方搞定</p>
          </blockquote>

          <div className="flex flex-col items-center justify-center gap-2 mb-6">
            <div className="flex items-center justify-center gap-3 text-gray-500">
              <span className="text-base">支持</span>
              <img src="/App_Store_(iOS).svg.png" alt="App Store" className="w-7 h-7"/>
              <img src="/Google_Play_2022_icon.svg.png" alt="Google Play" className="w-7 h-7"/>
            </div>
            <span className="text-xs text-gray-400">官方渠道接入，安全可靠</span>
          </div>
          <p className="text-base text-gray-500 mb-8 max-w-lg mx-auto leading-relaxed">
            {'“原本每天 1 小时翻评论，现在 5 分钟看完AI精准洞察”'}
          </p>
          <div className="flex flex-col items-center justify-center gap-3 mb-12">
            <a href="/demo" className="text-base font-medium text-white bg-gray-900 hover:bg-gray-700 px-6 py-2.5 rounded-full transition-colors">查看 Demo ↗</a>
            <a
              href="https://github.com/somar111/hushengradar"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub 仓库"
              className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 bg-gray-200 hover:bg-gray-300 px-4 py-1.5 rounded-full transition-colors"
            >
              <span>Github repo：</span>
              <img src="/github-svgrepo-com.svg" alt="" className="w-10 h-10" />
            </a>
          </div>

        </div>
      </main>

      {/* Features */}
      <section className="px-8 pb-20 max-w-4xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FeatureCard
            title="用户需求一目了然"
            desc="大量纯抱怨、语言混杂、毫无分类——真正有价值的反馈就这样淹没在噪音里。AI 自动提炼差评原因、整理功能愿望清单、对比版本口碑，还能直接问它评论区的任何问题"
          />
          <FeatureCard
            title="再也不被多语言评论困扰"
            desc="所有语言的评论自动翻译成目标语言集中查看，AI 按用户原语言生成回复，一键发送。双平台、多市场，再也不用来回切"
          />
          <FeatureCard
            title="还有这些"
            desc="恶意差评实时预警、每周自动生成口碑周报、关键指标自定义通知——重要的事会主动来找你，不用你盯着"
          />
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-xl p-6 min-h-36" style={{ background: 'linear-gradient(145deg, rgba(252,250,255,0.98) 0%, rgba(233,227,254,0.65) 100%)', border: '0.5px solid rgba(255,255,255,0.9)', boxShadow: 'inset 0 1.5px 0 rgba(255,255,255,1), inset 1px 0 0 rgba(255,255,255,0.6), inset 0 -1px 0 rgba(139,92,246,0.12), 0 8px 24px rgba(139,92,246,0.1)' }}>
      <h3 className="font-semibold text-gray-900 mb-2 text-base">{title}</h3>
      <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
    </div>
  );
}
