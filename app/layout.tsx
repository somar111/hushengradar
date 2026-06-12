import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "呼声雷达 | 全球 App 评论管理平台",
  description: "全球 App 开发者的评论交互中心。AI 分析差评趋势，多语言查看与一键回复，一个界面告别平台切换。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className={`${geist.variable} h-full`}>
      <body className="h-full antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
