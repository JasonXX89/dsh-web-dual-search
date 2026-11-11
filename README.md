# dsh-web-dual-search

Tavily 和 TinyFish 双后端的网页搜索/抓取插件，注册到 DeepSeek Harness 的
web 能力接缝（`ctx.web`）。一个插件，两个后端，搜索和抓取可以分别选用。

## 为什么是一个插件而不是两个

接缝的兜底选择规则是"恰好一个可用 provider"。两个独立插件各自注册一个
id，两把钥匙都在时选择就会歧义（`WEB_PROVIDER_AMBIGUOUS`）。一个插件、
两个显式 id、无歧义。

## Provider id

| id | 搜索 | 抓取 |
| --- | --- | --- |
| `tavily` | `POST {base}/search` | `POST {base}/extract` |
| `tinyfish` | `GET api.search.tinyfish.ai?query=…` | `POST api.fetch.tinyfish.ai` |

切换：profile 的 patch 层里改 `web` 行（两字段独立，可混搭）：

    - id: web
      config:
        searchProvider: tavily
        fetchProvider: tavily

## 字段映射（适配的核心）

Tavily 的报文字段与接缝词汇不一致，这是本插件存在的理由：

- `/search` 返回 `results[]{url,title,content,score,published_date,raw_content}`。
  接缝的 `snippet` 取自 `content`（短摘录），`summary` 取自 `raw_content`
  （整页文本，需 `includeRawContent`）。逐字段直译会得到没有任何摘录的来源。
- Tavily 没有 `/fetch` 路由——页面抽取在 `/extract`，入参 `{urls:[…]}`，
  另有 `failed_results[]`。某页取不到时按结果返回（HTTP 502 + 原因），
  不抛错：失败的是页面，不是能力。

TinyFish 的字段名与接缝几乎对齐（`snippet`/`description`），直映射。
其搜索偶发空结果（约三分之一），插件对空结果做一次有界重试。

日期统一转为 ISO-8601；无时区按 UTC 读（`Date.parse` 读本地时区会把
"Apr 30, 2026" 平移一天）。无法解析的日期丢弃——缺失诚实，伪造不诚实。

## 凭证解析顺序

1. 插件配置里的字面 `apiKey`（不推荐写进 patch 文件）
2. Harness 凭证服务（凭证名 = `apiKeyEnv`，默认 `TAVILY_API_KEY` / `TINYFISH_API_KEY`）
3. Provider 自带 CLI 的本地存储（`~/.tavily/.env`、`~/.tinyfish/config.json`）
4. 启动环境变量（`launchEnvironmentOf`：进程环境 → 项目 .env → 用户 .env）

`available()` 是同步的，无法 await 凭证服务；服务存在即视为"可能有钥"，避免
把已保存的钥匙报成缺失、被接缝在调用前拒掉。

## 安装

从 GitHub 安装：

    dsh plugin --profile web add github:JasonXX89/dsh-web-dual-search

或从本地源码安装：

    dsh plugin --profile web add ./dsh-web-dual-search

没有 pnpm 时（本机现状）：把包软链进 profile 的 `node_modules`，并把
`dsh-web-dual-search` 加进 profile `package.json` 的
`dsh.profile.bundles` 与 `dependencies`，peer 依赖软链到 dsh 安装目录。

## 配置

两级嵌套对象 `tavily.*` / `tinyfish.*`（baseURL、count、depth、domains、
snippetMaxChars、summaryMaxChars、bodyMaxChars……），顶层 `attempts` /
`retryDelayMs`。嵌套对象本身不 volatile——schemastery 禁止 volatile 嵌套
volatile，叶子字段各自 volatile 保证设置页可独立编辑。

## 测试

    node test/providers.test.mjs

11 个用例，桩掉 `fetch`：断言每个后端实际发出的请求（URL/方法/鉴权头/请求体）
与字段映射（snippet/summary/publishedAt/answer、失败页语义、非法 URL 丢弃、
空结果重试、日期时区）。

## 许可

MIT
