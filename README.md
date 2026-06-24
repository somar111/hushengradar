# 呼声雷达

AI 驱动的应用商店评论监控与分析工具。抓取 Google Play 公开评论，用 DeepSeek 做分类、翻译、摘要和回复建议，在 Demo 面板里集中查看。

> 当前为 Demo 阶段：评论抓取走公开渠道（非官方 API）；App Store 接入在 UI 层预留，数据管线尚未实现。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 / API | [Next.js 16](https://nextjs.org/) + React 19 + Tailwind CSS 4 | App Router，`/demo` 为分析面板 |
| 部署 | [OpenNext](https://opennext.js.org/cloudflare) + Cloudflare Workers | 域名 `hushengradar.com`，配置见 `wrangler.jsonc` |
| 数据库 | [Supabase](https://supabase.com/)（PostgreSQL） | 服务端用 Service Role Key，绕过 RLS |
| AI | [DeepSeek Chat](https://platform.deepseek.com/)（`deepseek-chat`） | 分类、翻译、摘要、insights、回复建议、问答 |
| 评论抓取 | [google-play-scraper](https://www.npmjs.com/package/google-play-scraper) | 仅 Google Play；增量抓取按 locale 水位线 |
| 定时任务 | GitHub Actions | 每日 UTC 02:00 跑 `scripts/cron-fetch.mjs` |
| 图表 | Recharts | Demo 面板统计图 |

Prompt 逻辑集中在 `lib/promptKit.mjs`；Next.js 路由和独立脚本共用这一份，避免重复维护。

## 项目结构

```
app/
  page.tsx              # 落地页
  demo/page.tsx         # 分析 Demo 面板
  api/demo/             # Demo API（apps / reviews / stats / insights / ask / ai-reply）
lib/
  promptKit.mjs         # 所有 AI prompt 构建
  classify.ts           # 运行时 AI 调用（回复、insights、问答）
  reviews.ts            # 数据查询与统计聚合
  supabase.ts           # Supabase 客户端与类型
scripts/
  add-app.mjs           # 一次性：接入新 App
  build-taxonomy.mjs    # 一次性：从评论样本设计分类体系
  cron-fetch.mjs        # 定时：抓取 → 分类 → 翻译 → 摘要
supabase/migrations/    # 数据库 schema 迁移
.github/workflows/
  deploy.yml            # push main → 部署 Cloudflare
  cron-fetch.yml        # 每日增量抓取
```

## 环境变量

密钥**不会**也**不应**提交到 git（`.env*`、`.dev.vars` 已在 `.gitignore` 中）。

| 变量 | 必填 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase 项目 URL（构建时注入，前端可见） |
| `SUPABASE_SECRET_KEY` | ✅ | Supabase Service Role Key（仅服务端 / 脚本） |
| `DEEPSEEK_API_KEY` | ✅ | DeepSeek API 密钥 |

本地开发从模板复制：

```bash
cp .env.example .env.local
# 填入真实值
```

Cloudflare 本地预览（`npm run preview`）额外需要 `.dev.vars`：

```bash
cat > .dev.vars <<'EOF'
SUPABASE_SECRET_KEY=eyJ...
DEEPSEEK_API_KEY=sk-...
EOF
```

### GitHub Secrets（CI / 定时任务）

在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置：

| Secret | 用于 |
|---|---|
| `SUPABASE_URL` | 构建时注入 `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_SECRET_KEY` | 运行时 + cron 脚本 |
| `DEEPSEEK_API_KEY` | 运行时 + cron 脚本 |
| `CLOUDFLARE_API_TOKEN` | `deploy.yml` 部署 Worker |
| `CLOUDFLARE_ACCOUNT_ID` | `deploy.yml` 部署 Worker |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Supabase

1. 在 [Supabase](https://supabase.com/) 创建项目。
2. 在 SQL Editor 中**按顺序**执行 `supabase/migrations/` 下的迁移文件。
3. 从 Dashboard → Project Settings → API 复制 URL 和 **service_role** key 到 `.env.local`。

> 生产数据库可能还包含迁移文件未覆盖的列/表（如 `locale_watermarks`、`ai_tag_keys`、翻译字段、`tag_summaries`）。若从零建库后脚本报列不存在，对照 `lib/supabase.ts` 和 `scripts/cron-fetch.mjs` 补全 schema。

### 3. 本地开发

```bash
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。Demo 面板在 `/demo`。

### 4. 接入第一个 App

```bash
# 从 Google Play 拉 listing，AI 生成 context 和起步分类，写入 apps 表
node scripts/add-app.mjs google_play com.example.app

# 可选：补充 listing 里没有的真实信息（客服邮箱、退款政策等）
node scripts/add-app.mjs google_play com.example.app --notes "客服：support@example.com"

# 从已有评论样本设计完整分类体系（建议首批评论入库后跑）
node scripts/build-taxonomy.mjs
# 或指定 app id：node scripts/build-taxonomy.mjs <uuid>
```

### 5. 手动跑一次增量管线（或等 GitHub Actions 定时跑）

```bash
node scripts/cron-fetch.mjs
```

流程：多 locale 增量抓取 → AI 分类 → 翻译 → 刷新标签摘要。

## 部署

### Cloudflare Workers（生产）

push 到 `main` 分支后 GitHub Actions 自动构建并部署。也可本地手动：

```bash
npm run deploy
```

需要已登录 wrangler（`npx wrangler login`）且本地有对应权限。生产密钥通过 GitHub Secrets 注入 Worker，不写在 `wrangler.jsonc` 里。

### 定时抓取

`cron-fetch.yml` 每天 UTC 02:00（北京时间 10:00）执行，也可在 Actions 页手动 `workflow_dispatch`。

## Demo API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/demo/apps` | App 列表 + 最新评论日期 |
| GET | `/api/demo/reviews` | 分页评论（`appId`, `tag`, `page` 等） |
| GET | `/api/demo/stats` | 聚合统计（标签分布、版本/地区评分等） |
| GET | `/api/demo/insights` | AI 综合分析（需 `DEEPSEEK_API_KEY`） |
| POST | `/api/demo/ask` | 问 AI（基于聚合数据） |
| POST | `/api/demo/ai-reply` | 单条评论回复建议 |

## 开发说明

- **AI 管线**：业务判断和措辞由 DeepSeek 在运行时生成；代码侧只负责数据聚合、调度和格式校验（如 `sanitizeTagKey`）。
- **分类体系**：每个 App 独立。通用三类（功能请求 / 好评 / 意义不明抱怨）固定；其余由 `build-taxonomy.mjs` 从真实评论归纳。
- **抓取范围**：`apps.target_locales` 配置 `[lang, country]` 列表；为空则用 `cron-fetch.mjs` 内置 14 组默认 locale。
- **平台支持**：自动抓取目前仅 `google_play`；`app_store` 在 schema 中预留，cron 会跳过。
