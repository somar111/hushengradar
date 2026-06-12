import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });

export const metadata: Metadata = {
  title: "呼声雷达 | 出海 App 评论管理平台",
  description: "连接 App Store 与 Google Play 官方开发者 API，AI 分析评论趋势，一键生成多语言回复",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className={`${geist.variable} h-full`}>
      <body className="h-full antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
