import type { Metadata } from "next";
import "./bio.css";

export const metadata: Metadata = {
  title: "产品经理自荐 ｜附独立产品 Demo",
  description:
    "阮好 · 产品经理自荐，附独立产品「呼声雷达」Demo。",
  openGraph: {
    title: "产品经理自荐 ｜附独立产品 Demo",
    description:
      "阮好 · 产品经理自荐，附独立产品「呼声雷达」Demo。",
    url: "https://hushengradar.com/bio",
    siteName: "呼声雷达",
    locale: "zh_CN",
    type: "website",
  },
};

export default function BioLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`body { background: #252528 !important; }`}</style>
      <div className="bio-root">{children}</div>
    </>
  );
}
