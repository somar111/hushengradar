// 将 docs/diagrams/*.mmd 导出为同名 SVG（README 嵌图用）。
// 用法：npm run diagrams
//
// 首次安装若 Chromium 下载慢，可：
//   PUPPETEER_SKIP_DOWNLOAD=true npm install
// macOS 渲染需本机 Chrome：
//   PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run diagrams
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagramsDir = path.join(root, "docs/diagrams");
const mmdc = path.join(root, "node_modules/.bin/mmdc");
const chrome =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);

if (!existsSync(mmdc)) {
  console.error("未找到 mmdc，请先运行 npm install");
  process.exit(1);
}

const env = { ...process.env };
if (chrome && existsSync(chrome)) env.PUPPETEER_EXECUTABLE_PATH = chrome;

const files = readdirSync(diagramsDir).filter((f) => f.endsWith(".mmd"));
if (!files.length) {
  console.log("docs/diagrams 下没有 .mmd 文件");
  process.exit(0);
}

for (const file of files) {
  const input = path.join(diagramsDir, file);
  const output = path.join(diagramsDir, file.replace(/\.mmd$/, ".svg"));
  const scale = file === "classification.mmd" ? "2.5" : "2";
  console.log(`渲染 ${file} → ${path.basename(output)} (scale ${scale})`);
  execFileSync(mmdc, ["-i", input, "-o", output, "-b", "transparent", "-s", scale], {
    stdio: "inherit",
    env,
  });
}

console.log("完成。");
