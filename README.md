# 呼声雷达

> 应用商店评论工作流，覆盖监控、理解、互动。多语言评论可筛可汇总、可问 AI，选中评论后还可在回复栏里起草回帖。

**在线 Demo**：[hushengradar.com/demo](https://hushengradar.com/demo)  
**落地页**：[hushengradar.com](https://hushengradar.com)

---

## 背景与目标

商店评论对产品迭代很重要，但实际用起来很麻烦：

- 量大、语言混杂，人工翻不过来
- 无具体反馈的纯抱怨和具体问题反馈搅在一起，很难看出 Top 问题
- 临时想问最近版本怎么样、某国用户在骂什么，没有统一入口
- 看完分析还得回应用商店后台一条条回

呼声雷达把整条链路串起来，不做死报表：

**同步 → 结构化 → 洞察 → 互动**。重活放离线管线（增量抓取 + AI 批处理）；日常操作在 Demo 面板：按问题筛评论、看图谱、问 AI、给单条评论出回复草稿（可按用户原语言），看懂和回复不用来回切工具。

---

## 产品形态

规划两种交付方式，底层同一套分析和 AI 逻辑：


| 形态        | 适合谁                          |
| --------- | ---------------------------- |
| **SaaS**  | 中小团队、希望开箱即用；商店账号授权接入，凭证由平台托管 |
| **私有化部署** | 需要数据留在自己环境，商店凭证客户自持          |


---

## 通用性与可定制的工作流

- 一套通用工作流服务任意 App：`add-app` 接入即可，标签从评论归纳、自动演进。
- 可定制项：


| 可定制项                   | 作用                   |
| ---------------------- | -------------------- |
| `context`              | 产品背景，注入分类、翻译、问 AI、回复 |
| `terminology_glossary` | 专名映射，翻译与 AI 输出不意译    |
| `taxonomy_meta.policy` | taxonomy 修订门槛、是否自动重判 |
| 回复语气 / 联系方式            | 回复建议（与问 AI 无关）       |


- AI 自动化：
  - 评论量大、没法人工逐条看 → cron 每日自动跑抓取、分类、翻译、标签摘要；taxonomy 按信号 enrich / 修订 / 重判
  - 体系大改可能误伤历史标注 → 破坏性变更进 `pending_reclassify`，确认后再 `reclassify-app`；`remap` 小改确定性落库
  - 临时想问、要写回复 → 面板问 AI、洞察、回复建议按需调用（不属自动化链路）

---

## 评论分类与子分类

- 一条评论常同时说好几件事，整段塞进模型又贵又乱 → 初判时为每个标签抽 evidence；`classifyReviewWithPipeline` 经结构校验、可疑才语义校准、原因后果专检后落库
- taxonomy 未成熟、子标签不够 → 母类满 2 个有效 sub 才强制 subKey；Top 反馈不够 chip 门槛时用摘要兜底，不硬凑（`praise` / `vague_complaint` 永不 breakdown）
- 冷启动噪声（临场造 sub、单批偶发） → 复用池须命中 ≥5 次且排除 `general`；taxonomy 修订看过命中量与跨天沉淀；低命中 ephemeral sub 清零重标
- 说不清该归哪个 sub → 暂归「其他」；满 20 条且过 3 天冷却才从 evidence enrich 新 sub 并重读原评论；滥用「其他」触发语义校准

```mermaid
%%{init: {"themeVariables": {"fontSize": "24px"}, "flowchart": {"nodeSpacing": 80, "rankSpacing": 90, "padding": 28}}}%%
flowchart TB
  subgraph ctx [分类上下文 per App]
    SEED[seed_categories]
    POOL[子问题复用池]
    SUBS[universal_subcategories]
    SEED --> GSUB["母类已有 2+ 有效 sub 才强制 subKey"]
    POOL --> GSUB
    SUBS --> GSUB
  end

  subgraph noise [前期噪声抑制]
    N1["复用池门槛: 单 sub 命中未满 5 次不进池"]
    N2["本轮新造 sub 不进复用池"]
    N3["taxonomy 信号: 命中量 + 跨天沉淀才触发修订"]
    N4["低命中 ephemeral sub 清零重标"]
  end

  subgraph pipe [单条管线 classifyReviewWithPipeline]
    IN[评论 + 评分] --> LLM1[LLM 初判 + evidence]
    GSUB --> LLM1
    N1 -.-> POOL
    N2 -.-> POOL
    LLM1 --> FIN[finalizeClassifiedTags 确定性收尾]
    FIN --> VAL{结构校验}
    VAL -->|未过| RETRY[重试初判]
    RETRY --> LLM1
    VAL --> SEM{可疑信号 needsSemanticCalibration}
    SEM -->|是| LLM2[语义校准 reroute]
    SEM -->|否| CC{原因后果并存}
    LLM2 --> CC
    CC -->|是| LLM3[原因后果专检]
    CC -->|否| SAVE[写入 reviews.ai_tags]
    LLM3 --> SAVE
  end

  subgraph general [其他桶 subKey=general]
    G0["说不清具体 sub 时暂归其他"]
    G1["general 永不进入复用池"]
    G2["母类已有具体 sub 仍标其他 触发语义校准"]
    G3["单父类其他满 20 条 + 冷却 3 天"]
    G3 --> G4[从其他 evidence 归纳新 sub]
    G4 --> G5[重置该父类下其他评论]
    G5 --> pipe
  end

  subgraph evo [批后演进 cron-fetch / reclassify-app]
    SAVE --> FR[feature_request 子问题归纳]
    FR --> SIGS[收集孤儿 / 碎片 / vague 占比等信号]
    N3 -.-> SIGS
    SIGS --> TD{过门槛}
    TD -->|bootstrap 或 revise| TAI[taxonomy AI 设计或修订]
    TD -->|跳过| POST[后续维护]
    TAI --> MIN[ensureTaxonomyMinSubs]
    MIN --> CHG{变更类型}
    CHG -->|remap| REMAP[确定性改历史标签]
    CHG -->|reclassify| PEND[pending_reclassify 待确认]
    PEND --> RERUN[reclassify-app 批量重读]
    RERUN --> pipe
    REMAP --> POST
    POST --> N4
    N4 -->|有重置| pipe
    SAVE --> G0
    G0 --> G1
    G0 --> G2
    SAVE --> G3
  end

  subgraph ui [Top 反馈展示]
    SAVE --> UIQ{"2+ 有效 sub 且各命中 2+"}
    UIQ -->|是| CHIP[子标签 chip 下钻]
    UIQ -->|否| SUM[摘要短语 tag_summaries / scoped]
  end
```



---

## 问 AI（askTools）

- 评论库塞不进 context → 不灌全库，通过 `get_stats` / `count_reviews` / `summarize_reviews` / `query_reviews` 按需取证
- 抽几条样本容易以偏概全 → 要主题先对 scope 内 evidence 全量归纳，超 1600 条 map-reduce 合并，再 `query_reviews` 补少量引用
- 「最近一周」锚服务器今天，窗口尾部会空 → 相对时间锚该 App `latestReviewDate`，与 Demo 列表同口径
- 归纳样本数被误当成评论总数 → `askCountPrefetch` 预取统计；作答只报 `total`，不用 `evidenceUsed` 代替

```mermaid
%%{init: {"themeVariables": {"fontSize": "24px"}, "flowchart": {"nodeSpacing": 80, "rankSpacing": 90, "padding": 28}}}%%
flowchart TB
  subgraph ctx [问答上下文]
    Q[用户问题 + 筛选 since / locale / tag]
    ANCHOR[latestReviewDate 时间锚]
    APP[appContext + seed_categories + 术语表]
  end

  subgraph api [ask route answerQuestionStream]
    Q --> STREAM[构建 buildAskPrompt]
    ANCHOR --> STREAM
    APP --> STREAM
    STREAM --> PREF[askCountPrefetch 可选预取 get_stats]
    PREF --> DS[DeepSeek 多轮 tool_calls]
    STREAM --> DS
  end

  subgraph tools [工具按需取证]
    DS --> T1[get_stats / count_reviews]
    DS --> T2[summarize_reviews]
    DS --> T3[query_reviews quotes]
    T1 --> DB[(reviews + 聚合统计)]
    T2 --> DB
    T3 --> DB
    T2 --> MR[超 1600 条 map-reduce 合并主题]
    MR --> DS
  end

  subgraph out [作答与纪律]
    DS --> SAN[sanitizeAskCounts 条数口径]
    SAN --> NDJSON[流式 NDJSON 返回面板]
  end
```



---

## 架构（当前 Demo）

```mermaid
flowchart TB
  GP[Google Play 公开页] --> Cron[cron-fetch.mjs]

  subgraph pipeline [离线管线 — GitHub Actions / 本地]
    Cron --> Classify[AI 分类]
    Classify --> Translate[AI 翻译]
    Translate --> Summarize[标签摘要]
  end

  DB[(Supabase / PostgreSQL)]

  Cron -->|upsert 评论| DB
  Classify -->|写 ai_tags| DB
  Translate -->|写译文| DB
  Summarize -->|写 tag_summaries| DB

  subgraph app [应用层]
    UI[Demo 面板 /demo]
    API[Next.js API Routes]
    DS[DeepSeek Chat API]
  end

  DB <-->|查询 / 聚合| API
  API --> UI
  API -->|问 AI · 回复 · 洞察 · 重分类| DS
  Classify --> DS
  Translate --> DS
  Summarize --> DS
```



离线主链路：抓取 → 分类（含 taxonomy 演进与按需重判）→ 翻译 → 标签摘要；重活放 cron，面板以查库为主，问 AI / 回复 / 洞察等按需调 DeepSeek。分类、校准、翻译、摘要、问 AI、回复等 prompt 集中在 `promptKit`，cron 与面板 API 共用。前端 Next.js / React / Tailwind；部署 OpenNext + Cloudflare Workers。

---

## 演进方向（产品化，非当前 Demo）

Demo 先验证 AI 分析 + 互动这条工作流；正式版会在接数据和回帖上换成官方渠道。

### 商店官方接入（和 Demo 抓取不是一回事）


| 平台              | 接入方式                                                                         | 凭证                                                                                  |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Google Play** | [Google Play Developer API](https://developers.google.com/android-publisher) | Google Cloud 项目 + Service Account（JSON）；Play 管理中心里关联并授权。用来拉评论、发回复，不是现在 Demo 用的公开页抓取 |
| **App Store**   | [App Store Connect API](https://developer.apple.com/app-store-connect/api/)  | Issuer ID、Key ID、`.p8` 私钥；库表和 UI 预留了，管线还没写                                          |


两种形态下商店凭证都由客户创建并授权：SaaS 下由平台安全托管，私有化部署下只在客户环境里。

### 其他


| 方向     | 说明                |
| ------ | ----------------- |
| 鉴权与多租户 | 按客户 / App 隔离      |
| 通知与周报  | 落地页里说的那些主动推送      |
| 商店回帖   | 面板起草 → 官方 API 直接发 |


抓取和回帖层可以换；分类、统计、面板互动按长期产品来设计，Demo 已经跑通从同步到出回复草稿这条主链路。

---

## 许可

All rights reserved.