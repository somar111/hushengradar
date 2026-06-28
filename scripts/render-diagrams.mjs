// 将 docs/diagrams/*.mmd 导出为同名 SVG（README 嵌图用）。
// 用法：npm run diagrams
//
// 灰黑底主题（见 mermaid-config.json）：比 GitHub 暗色页更浅，偏灰；浅色/深色 README 下均自成一块。
// 首次安装若 Chromium 下载慢，可：
//   PUPPETEER_SKIP_DOWNLOAD=true npm install
// macOS 渲染需本机 Chrome：
//   PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run diagrams
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagramsDir = path.join(root, "docs/diagrams");
const configFile = path.join(diagramsDir, "mermaid-config.json");
const diagramTheme = JSON.parse(readFileSync(configFile, "utf8"));
const diagramBg = diagramTheme.themeVariables?.background ?? "#333338";
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

/** GitHub README 把 width="100%" 的 SVG 压进窄栏；改为固定像素宽，点开原图可浏览器缩放。 */
function postProcessSvg(svgPath) {
  let svg = readFileSync(svgPath, "utf8");
  const vb = svg.match(/viewBox="([^"]+)"/);
  if (!vb) return;

  const parts = vb[1].trim().split(/\s+/).map(Number);
  if (parts.length !== 4) return;
  const [, , w, h] = parts;

  svg = svg.replace(/(<svg\b[^>]*?)\bwidth="[^"]*"/, `$1width="${w}"`);
  if (!/<svg\b[^>]*\bwidth=/.test(svg)) {
    svg = svg.replace(/<svg\b/, `<svg width="${w}"`);
  }
  svg = svg.replace(/(<svg\b[^>]*?)\bheight="[^"]*"/, `$1height="${h}"`);

  svg = svg.replace(
    /(<svg\b[^>]*?)style="[^"]*background-color:[^"]*"/,
    `$1style="background-color: ${diagramBg}"`
  );
  if (!/<svg\b[^>]*style=/.test(svg)) {
    svg = svg.replace(/<svg\b/, `<svg style="background-color: ${diagramBg}"`);
  }

  if (!svg.includes('id="diagram-bg"')) {
    svg = svg.replace(
      /(<svg\b[^>]*>)/,
      `$1<rect id="diagram-bg" x="0" y="0" width="${w}" height="${h}" fill="${diagramBg}"/>`
    );
  } else {
    svg = svg.replace(
      /(<rect id="diagram-bg"[^>]*fill=")[^"]*(")/,
      `$1${diagramBg}$2`
    );
  }

  writeFileSync(svgPath, svg);
}

const files = readdirSync(diagramsDir).filter((f) => f.endsWith(".mmd"));
if (!files.length) {
  console.log("docs/diagrams 下没有 .mmd 文件");
  process.exit(0);
}

for (const file of files) {
  const input = path.join(diagramsDir, file);
  const output = path.join(diagramsDir, file.replace(/\.mmd$/, ".svg"));
  const scale = "2.5";
  console.log(`渲染 ${file} → ${path.basename(output)} (scale ${scale})`);

  const args = [
    "-i",
    input,
    "-o",
    output,
    "-t",
    "dark",
    "-b",
    diagramBg,
    "-s",
    scale,
    "-c",
    configFile,
  ];
  execFileSync(mmdc, args, { stdio: "inherit", env });
  postProcessSvg(output);
}

console.log("完成。");
