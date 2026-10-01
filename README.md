# 科研雷达 · Research Radar

一个手机端的信息平台，一个页面看两件事：

| 标签页 | 内容 | 数据来源 |
|---|---|---|
| 🔬 **科研顶刊** | 心血管 + 重症前沿顶刊速递，按六大方向分类，按期影响因子标注 | [Europe PMC](https://europepmc.org/) REST API |
| 🤖 **AI Builder** | 26 位一线 AI builder 的 X 动态、播客、官方博客 | [follow-builders](https://github.com/zarazhangrui/follow-builders) 公共 feed |

**打开即最新**：页面每次打开都直接向两个上游实时抓取，没有后端、没有定时任务、没有 API key。抓到的数据会缓存在浏览器本地（30 分钟），所以第二次打开是秒开的，同时后台再静默校验一次。

---

## 目录结构

```
research-radar/
├── index.html                     # 单页应用
├── manifest.webmanifest           # PWA：可「添加到主屏幕」
├── sw.js                          # Service Worker：离线可用
├── assets/
│   ├── styles.css                 # 全部样式（浅色，移动优先）
│   ├── app.js                     # 全部逻辑（零依赖，原生 JS）
│   ├── icon.svg / icon-*.png      # 应用图标
├── data/
│   ├── journals.config.json       # 47 本期刊 + ISSN + 影响因子 + 方向（唯一需要改的配置）
│   ├── glossary.json              # 96 条专业词汇
│   ├── snapshot-journals.json     # 兜底快照（接口挂了也能看）
│   └── snapshot-builders.json     # 兜底快照
├── scripts/
│   ├── validate_issns.py          # 校验 ISSN 是否有效（改期刊列表后跑一次）
│   ├── build_snapshot.py          # 生成兜底快照
│   └── qa.js                      # 无头浏览器 QA
└── .github/workflows/
    └── refresh-snapshots.yml      # 可选：每天 07:20 (CST) 刷新快照
```

---

## 科研顶刊是怎么来的

**一句话：Europe PMC 一次查询拿到 47 本顶刊近 14 天带摘要的全部新文章，再在浏览器里分类。**

选 Europe PMC 而不是 Scopus / PubMed 的原因：

- **免 key、免配额**，可以直接从浏览器调用（`Access-Control-Allow-Origin: *`）。
- **带摘要**。Crossref 对 Elsevier 系期刊完全不返回摘要（NEJM、Lancet、JACC 全部 0/20），只有标题没结论。
- **支持多 ISSN 联合查询**，47 本期刊一次请求搞定，不用逐本循环。

查询语句长这样：

```
(ISSN:"0140-6736" OR ISSN:"0028-4793" OR …)
  AND SRC:MED
  AND HAS_ABSTRACT:Y
  AND FIRST_PDATE:[2026-09-17 TO 2026-10-01]
```

几个关键设计：

1. **必须加 `HAS_ABSTRACT:Y`。** Europe PMC 的 `journal-article` 类型太粗，会混进勘误（`Department of Error`）、讣告、通讯、评论。「有摘要」是唯一能把真正的研究论文干净分出来的条件。
2. **窗口取 14 天，不是 1 天。** 摘要入库比文章发表滞后 2–4 天，1 天窗口基本是空的。用 14 天窗口 + 前端去重，才是稳定可用的做法。
3. **拆成 3 段查询再合并。** 单次查询会被高产的期刊淹没——JAHA 两周发 33 篇，会把 NEJM、Lancet 全部挤出去。拆段 + 每刊最多 8 篇（`CAP_PER_JOURNAL`），保证顶刊一定在列表里。
4. **不写「今日发表」。** 页面显示的是文章真实的 `firstPublicationDate`，不美化。

### 六大方向是怎么分的

`app.js` 里的 `DIRS` 用正则给标题（权重 ×3）和摘要打分，取最高分的方向；都没命中就回落到期刊本身的分类。顺序即优先级：

`肺动脉高压 → 主动脉夹层 → 心力衰竭 → 高血压 → 重症医学 → 心血管疾病`

### 影响因子 → 星级

| IF | ★ |
|---|---|
| ≥ 30 | ★★★★★ |
| ≥ 15 | ★★★★ |
| ≥ 8 | ★★★ |
| ≥ 4 | ★★ |
| < 4 | ★ |

IF 取 2024 JCR 的近似值，只用来做视觉分级，**不要当作引用依据**。展开卡片里会显示精确数值。

---

## AI Builder 资讯是怎么来的

直接读 [follow-builders](https://github.com/zarazhangrui/follow-builders) 仓库每天自动更新的三个公共 feed（`raw.githubusercontent.com` 同样允许跨域）：

- `feed-x.json` — 26 位 builder 的 X 动态（Karpathy、swyx、Amjad Masad、Guillermo Rauch、Sam Altman…）
- `feed-blogs.json` — Anthropic Engineering、Claude Blog 等官方博客全文
- `feed-podcasts.json` — Latent Space、No Priors、Training Data 等 6 档播客

该仓库的理念是 **follow builders, not influencers**——跟的是真正在做产品的人，不是搬运信息的网红。

---

## 本地预览

```bash
cd research-radar
python -m http.server 8777
# 手机浏览器打开 http://<你的电脑IP>:8777
```

必须用 HTTP 服务，直接双击 `index.html`（`file://`）会导致 fetch 和 Service Worker 失效。

---

## 部署到 GitHub Pages

```bash
cd research-radar
git init -b main
git add -A
git commit -m "feat: 科研雷达 — 顶刊速递 + AI Builder"
git remote add origin https://github.com/<你的用户名>/research-radar.git
git push -u origin main
```

然后仓库 **Settings → Pages → Source 选 `Deploy from a branch` → `main` / `/ (root)`**，等 1 分钟。

手机访问 `https://<你的用户名>.github.io/research-radar/`，Safari/Chrome 里「添加到主屏幕」就是一个 App 图标。

> 仓库里的 `.nojekyll` 不能删——否则 GitHub Pages 的 Jekyll 会忽略下划线开头的路径。

---

## 怎么改成你自己的方向

编辑 `data/journals.config.json`，一行一本期刊：

```json
{ "issn": "0140-6736", "title": "The Lancet", "short": "Lancet",
  "if": 98.4, "group": "top" }
```

`group` 可选：`top` `cvd` `hf` `htn` `aortic` `ph` `icu`。

**加完必须校验 ISSN**，错的 ISSN 会静默返回 0 条：

```bash
python scripts/validate_issns.py     # 逐本查询并报告 90 天内的文章数
```

要改方向（比如换成肿瘤、神经），同步改 `app.js` 的 `DIRS` 数组和 `data/glossary.json` 即可。

---

## 已知边界

- **摘要有 2–4 天滞后**，这是 Europe PMC 的入库节奏，不是 bug。所以页面显示的是「最新推送」而不是「今日推送」。
- **IF 是近似值**，用于星级分级，会随 JCR 年度更新而漂移。
- **顶刊速递筛选阈值是 IF ≥ 20**，想更严/更松就改 `app.js` 里 `renderResearch()` 的那个 `20`。
- 上游接口偶发波动时，页面会自动回落到 `data/snapshot-*.json` 快照并给出提示。
