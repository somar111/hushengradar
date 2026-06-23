import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "呼声雷达 | 全球 App 评论管理平台",
  description: "全球 App 开发者的评论交互中心。AI 分析差评趋势，多语言查看与一键回复，一个界面告别平台切换。",
};

const MOBILE_UA = /Mobi|Android|iPhone|iPod/i;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const userAgent = (await headers()).get("user-agent") ?? "";
  const isMobile = MOBILE_UA.test(userAgent);

  return (
    <html lang="zh" className={`${geist.variable} h-full`}>
      <body className="h-full antialiased" suppressHydrationWarning>
        {isMobile ? <MobileNotice /> : children}
      </body>
    </html>
  );
}

function MobileNotice() {
  return (
    <div className="min-h-full flex items-center justify-center bg-[rgb(254,252,246)] text-gray-900 text-center px-6">
      <div className="max-w-sm">
        <h1 className="text-2xl font-bold mb-3">呼声雷达</h1>
        <p className="text-gray-500 leading-relaxed">
          请在电脑端浏览器访问，移动端网站暂未适配（本周会完成），敬请期待
        </p>
      </div>
    </div>
  );
}
