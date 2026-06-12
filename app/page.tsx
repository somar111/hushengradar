import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col font-[family-name:var(--font-geist)]">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="text-lg">📡</span>
          <span className="font-semibold tracking-tight">呼声雷达</span>
        </div>
        <Link
          href="/demo"
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          查看 Demo →
        </Link>
      </nav>

      {/* Hero */}
      <main className="flex-1 flex flex-col items-center justify-center px-8 py-24 text-center">
        <div className="max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-4 py-1.5 text-sm text-indigo-400 mb-10">
            <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
            Demo 版本现已上线
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 leading-[1.1]">
            出海 App 的
            <br />
            <span className="text-indigo-400">评论管理中枢</span>
          </h1>

          <p className="text-lg text-gray-400 mb-3 leading-relaxed">
            连接 App Store 与 Google Play 官方开发者 API
          </p>
          <p className="text-base text-gray-500 mb-12 max-w-lg mx-auto leading-relaxed">
            AI 深度分析差评趋势，自动生成多语言回复建议
            <br />
            一个界面，告别平台切换
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/demo"
              className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-8 py-3 rounded-lg transition-colors text-sm w-full sm:w-auto"
            >
              查看 Demo →
            </Link>
            <a
              href="mailto:crystalismm@proton.me"
              className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            >
              寻求合作 →
            </a>
          </div>
        </div>
      </main>

      {/* Features */}
      <section className="px-8 pb-20 max-w-4xl mx-auto w-full">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <FeatureCard
            icon="🔗"
            title="官方 API 接入"
            desc="通过 App Store Connect 和 Google Play 官方开发者 API 获取数据，安全合规，无需爬虫"
          />
          <FeatureCard
            icon="🤖"
            title="AI 深度分析"
            desc="自动提取 Top 差评问题、功能愿望清单、营销金句，支持版本对比分析"
          />
          <FeatureCard
            icon="💬"
            title="多语言一键回复"
            desc="AI 生成英日韩多语言回复建议，在同一界面审核并一键提交，无需切换平台"
          />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 px-8 py-6 text-center text-sm text-gray-600">
        寻求技术合作 ·{" "}
        <a
          href="mailto:crystalismm@proton.me"
          className="text-gray-500 hover:text-gray-400 transition-colors"
        >
          crystalismm@proton.me
        </a>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  desc,
}: {
  icon: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="bg-gray-900 border border-white/5 rounded-xl p-6">
      <div className="text-2xl mb-3">{icon}</div>
      <h3 className="font-semibold text-white mb-2 text-sm">{title}</h3>
      <p className="text-sm text-gray-400 leading-relaxed">{desc}</p>
    </div>
  );
}
