# 科研雷达 · Research Radar

一个手机端的信息平台，一个页面看两件事：

| 标签页 | 内容 | 数据来源 |
|---|---|---|
| 🔬 **科研顶刊** | 临床顶刊 + 基础/分子医学每日速递，按领域分类，标注研究类型与临床/基础 | [Europe PMC](https://europepmc.org/) + [Crossref](https://api.crossref.org) |
| 🤖 **AI Builder** | 26 位一线 AI builder 的 X 动态、播客、官方博客 | [follow-builders](https://github.com/zarazhangrui/follow-builders) 公共 feed |

**打开即最新**：页面每次打开都直接向上游实时抓取，没有后端、没有定时任务、没有 API key。数据缓存在浏览器本地（30 分钟），第二次打开秒开，后台再静默校验一次。

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
│   └── icon.svg / icon-*.png      # 应用图标
├── data/
│   ├── journals.config.json       # 55 本期刊 + ISSN + 领域 + 临床/基础 + 影响因子
│   ├── glossary.json              # 96 条专业词汇
│   ├── digest.json                # 每日「创新 / 看点」（由 GitHub Action 生成）
│   ├── pushed.txt                 # 已推送过的 DOI，避免隔天重复
│   ├── snapshot-journals.json     # 兜底快照（接口挂了也能看）
│   └── snapshot-builders.json     # 兜底快照
├── scripts/
│   ├── build_config.py            # 校验 ISSN、抓期刊名、输出配置
│   ├── build_snapshot.py          # 生成兜底快照 + 今日精选算法
│   ├── build_digest.py            # 调 LLM 生成「创新 / 看点」
│   └── qa.js                      # 无头浏览器 QA
└── .github/workflows/
    ├── refresh-snapshots.yml      # 每天 05:40 (CST) 刷新兜底快照
    └── daily-digest.yml           # 每天 06:00 (CST) 生成通俗版摘要
```

---

## 期刊池

**38 本临床顶刊 + 17 本 CNS / 基础医学期刊（共 55 本）**，全部逐个校验过 ISSN。

- **临床**：Lancet 全家族（肿瘤/神经/感染/呼吸/内分泌/消化肝病/血液/风湿/精神/公共卫生/全球健康/数字医疗/儿科/老年/HIV/微生物）、JACC 全家族、CHEST、Ophthalmology 家族、Annals of Oncology、Journal of Hepatology、Kidney International、JAAD、European Urology、NEJM、EClinicalMedicine
- **基础/分子**：Cell、Nature、Science、Nature Genetics、Nature Immunology、Cell Stem Cell、Science Translational Medicine、Science Advances、Nature Communications、Cell Reports、Cell Host & Microbe、Cell Systems、Nature Biomedical Engineering、Nature Biotechnology、Nature Neuroscience、Neuron、JACC: Basic to Translational Science

> 原任务文档里的 **CHEST Pulmonary (2949-7884)** 和 **CHEST Critical Care (2949-7892)** 在 Europe PMC 返回 0 条——两本刊太新，尚未被 MEDLINE 收录，因此未纳入。**Nature Biomedical Engineering** 的正确 ISSN 是 `2157-846X`（`2372-7705` 无效）。

---

## 科研顶刊是怎么来的

**一句话：Europe PMC 一次查询拿到 55 本顶刊近 30 天带摘要的全部新文章，在浏览器里解析结构、判定研究类型、按规则精选。**

选 Europe PMC 而不是 Scopus / PubMed 的原因：**免 key、免配额、带摘要、支持多 ISSN 联合查询**。（Crossref 对 Elsevier 系期刊完全不返回摘要，NEJM、Lancet、JACC 全部 0/20。）

```
(ISSN:"0140-6736" OR ISSN:"0028-4793" OR …)
  AND SRC:MED AND HAS_ABSTRACT:Y AND FIRST_PDATE:[<lo> TO <hi>]
```

### 关键设计

1. **必须加 `HAS_ABSTRACT:Y`。** `journal-article` 类型太粗，会混进勘误（`Department of Error`）、讣告、通讯、评论。「有摘要」是唯一能干净分出真正研究论文的条件。
2. **窗口取 30 天，不是 1 天。** 摘要入库滞后发表 2–4 天，1 天窗口基本是空的。
3. **拆成 3 段查询再合并。** 单次查询会被高产期刊淹没——Nature Communications 一季度 2282 篇。拆段 + **每刊最多 8 篇**，保证小刊也能露脸。
4. **不写「今日发表」。** 显示的是文章真实的 `firstPublicationDate`。

### 领域（21 个）

领域直接来自期刊本身，不做关键词猜测——Lancet Oncology 就是肿瘤，JACC 就是心血管，准确率 100%。

综合医学 · 心血管 · 呼吸与重症 · 肿瘤 · 神经 · 感染 · 血液 · 内分泌代谢 · 消化肝病 · 公共卫生 · 眼科 · 儿科 · 精神心理 · 风湿免疫 · 肾脏 · 皮肤 · 泌尿 · 全球健康 · 数字医疗 · 老年医学 · 基础医学

### 研究类型（12 类）

**`pubTypes` 几乎没用**——实测绝大多数文章只返回 `['Journal Article']`。所以研究类型是从**摘要正文**里读出来的：

| 优先级 | 类型 | 判定依据 |
|---|---|---|
| 6 | 指南/共识 · 荟萃分析 · 随机对照试验 | practice guideline / meta-analysis / randomized controlled trial |
| 5 | 疾病负担分析 · 多中心研究 · 前瞻队列 | global burden of disease / multicenter / prospective cohort |
| 4 | 注册研究 · 基础研究 | registry / in vivo, knockout, single-cell |
| 3 | 病例对照 · 回顾性研究 · 研究论文 | case-control / retrospective |
| 1–2 | 综述 · 评论/社论 | this review / this editorial |

期刊若真的提供了 `pubTypes`（NEJM 会返回 `Randomized Controlled Trial` 等），则以它为准——它是权威标签。

### 结构化摘要：目的 / 方法 / 结果 / 结论

Europe PMC 返回的摘要**自带小标题**（`<h4>Background</h4>…<h4>Results</h4>…`）。解析成中文四段，比一整块文字好读得多：

| 原小标题 | 映射 |
|---|---|
| Background / Objective / Purpose / Research question / Aims | **目的** |
| Methods / Design / Patients and participants / Main outcome measures | **方法** |
| Results / Findings / Main results | **结果** |
| Conclusions / Interpretation / Discussion / Translation | **结论** |
| Funding / Trial registration / Financial disclosure | 丢弃 |

当前 189 篇里有 101 篇是结构化摘要（53%），其余回退成整段原文。

> **陷阱**：基因名也用小标题标签包裹（`TRAF7`、`Cxcl1`、`BBX28`、`IAA19`…）。解析器只在标签文本**命中已知小标题词表**时才当作分段，否则忽略——否则一篇分子生物学论文会被切成十几个假章节。

### 今日精选（默认视图）

从当日池子里精选 **8 篇 = 4 篇临床 + 4 篇基础/分子医学**：

- **基础 4 篇**，且**一刊一篇**——否则一本刊（如 Cell）能占满，出现两篇几乎雷同的论文
- **临床 4 篇**，优先覆盖不同领域（优先补还没出现过的领域）
- **同刊最多 2 篇**；某一边候选不足时用另一边补足总数
- 排序权重 = 研究类型等级 ×1000 + 影响因子 + 结构化摘要加成

「今日首选」由 LLM 在 8 篇中评出（选证据等级最高、临床影响最大的一篇）。

### 创新 / 看点（LLM 生成）

任务文档要求的「创新 / 看点」需要模型精读摘要才能写，静态前端做不到。做法是**每天用 GitHub Action 调 LLM 生成，结果提交成静态数据** `data/digest.json`，页面直接读——不需要任何服务器。

- **脚本**：`scripts/build_digest.py`，OpenAI 兼容格式，默认 DeepSeek（`deepseek-chat`）
- **提示词**：把当日精选 8 篇的**摘要原文**一起发给模型，要求用**大白话**写，
  语气像跟同科室同事讲「这篇为什么能上顶刊」。五个部分按叙事顺序：
  - `background` **背景** —— 这个病/问题为什么重要？此前卡在哪、缺什么
  - `methods` **怎么做的** —— 找了什么人、怎么分组、比了什么、看什么结局，像讲故事一样说清楚
  - `innovation` **创新点** —— 新在哪？为什么值得上顶刊
  - `takeaway` **看点 / 临床含义** —— 关键数字 + 对临床决策意味着什么，争议和局限也直说
  - `future` **未来研究方向** —— **明确禁止写「摘要未提及」**，要基于摘要里已有的结果、
    机制、人群给出合理且有意义的方向（这是唯一允许「超出摘要」的部分）
  - 另外写 `titleZh`，格式固定为 `<中文主题>（<刊名>，<领域>，<研究类型>）`
  - 并选出 1 篇「今日首选」+ 理由
- **硬性约束写死在提示词里**：①②③④ 只能用摘要明确写出的信息，不得推测编造；数字必须与摘要
  完全一致；**大白话**（短句、主动语态、不照抄英文句式、不堆术语）；必须出现的术语保留英文原词
  （hazard ratio、intention-to-treat…）并顺手解释一句；每部分 ≤140 字
- **去重**：选中的 DOI 追加到 `data/pushed.txt`，次日不会再推同样的文章
- **成本**：每天 1 次调用、约 6k input tokens

页面上的呈现：展开卡片后，**通俗版五段**以彩色编辑注显示在最前面（不用滚动就能看到）；下方是**折叠起来**的英文摘要原文，需要时点「▸ 查看英文摘要原文」展开——这样卡片聚焦在好读的通俗版，原文又随时可查。「今日首选」的卡片带金色边框和 ⭐ 角标。

> **digest 存在时，它定义「今日精选」**——页面用 digest 里的 DOI 顺序作为精选列表，保证编辑注和精选永远对得上。digest 缺失或超过 5 天，则回落到浏览器端的实时精选算法。

**启用步骤**（一次性）：

1. 去 platform.deepseek.com 拿一个 API key
2. 仓库 **Settings → Secrets and variables → Actions → New repository secret**，名字填 `DEEPSEEK_API_KEY`
3. 到 **Actions** 页面点 **Daily digest (创新 / 看点) → Run workflow** 手动跑一次验证

换厂商只需改仓库 **Variables**（不用改代码）：`LLM_BASE_URL` + `LLM_MODEL`，key 放 `LLM_API_KEY` 即可（任何 OpenAI 兼容端点都行，如通义千问、Kimi、OpenAI）。

### 原文链接

- **ClinicalKey 深链**：Europe PMC 不提供 PII，所以向 Crossref 取 `alternative-id`。`filter=doi:a,doi:b` 支持一次批量查 20 个 DOI，因此整个列表只需几次请求。只有真的 PII（`^S[0-9X]{10,}$`）才生成 ClinicalKey 链接。
  `https://www.clinicalkey.com/#!/content/playContent/1-s2.0-<PII>`
- **DOI 全文**：`https://doi.org/<DOI>`（无 ClinicalKey 订阅权限时的兜底，始终显示）
- **PubMed**：`https://pubmed.ncbi.nlm.nih.gov/<PMID>/`

### 去重记录（未读）

任务文档第 5 步要求维护 `pushed.txt` 避免次日重复推送。浏览器里等价物是 localStorage：**展开过的卡片自动标为已读**，`🆕 未读` 筛选只显示没读过的，列表头有「全部已读」一键清空。

### 索引表视图

列表头可切 **卡片 / 索引表**。索引表就是任务文档要的窄索引表：`# / 期刊 / 类型 / 领域 / 临·基`，点任意一行跳回对应卡片并展开。

---

## AI Builder 资讯是怎么来的

直接读 [follow-builders](https://github.com/zarazhangrui/follow-builders) 每天自动更新的三个公共 feed（`raw.githubusercontent.com` 允许跨域）：

- `feed-x.json` — 26 位 builder 的 X 动态（Karpathy、swyx、Amjad Masad、Guillermo Rauch、Sam Altman…）
- `feed-blogs.json` — Anthropic Engineering、Claude Blog 等官方博客
- `feed-podcasts.json` — Latent Space、No Priors、Training Data 等 6 档播客

该仓库的理念是 **follow builders, not influencers**——跟的是真正在做产品的人，不是搬运信息的网红。

---

## 本地预览

```bash
cd research-radar
python -m http.server 8777
# 手机浏览器打开 http://<你的电脑IP>:8777
```

必须走 HTTP，直接双击 `index.html`（`file://`）会让 fetch 和 Service Worker 失效。

---

## 部署到 GitHub Pages

```bash
cd research-radar
git init -b main
git add -A
git commit -m "feat: 科研雷达"
git remote add origin https://github.com/<你的用户名>/research-radar.git
git push -u origin main
```

然后仓库 **Settings → Pages → Source 选 `Deploy from a branch` → `main` / `/ (root)`**。

> `.nojekyll` 不能删——否则 GitHub Pages 的 Jekyll 会忽略下划线开头的路径。

---

## 怎么改

**换期刊**：编辑 `data/journals.config.json`，一行一本：

```json
{ "issn": "0140-6736", "title": "The Lancet", "short": "Lancet",
  "domain": "综合医学", "basic": false, "if": 98.4 }
```

`domain` 取上面 21 个领域之一；`basic: true` 表示基础/分子医学期刊。

**加完必须校验 ISSN**——错的 ISSN 会静默返回 0 条，不报错：

```bash
python scripts/build_config.py --sample   # 逐本查询 + 抽样摘要小标题
```

**改方向**（比如专做肿瘤）：在 `journals.config.json` 里只留目标期刊，`app.js` 的 `DOMAIN_META` 和 `data/glossary.json` 同步调整即可。

---

## 已知边界

- **摘要有 2–4 天滞后**，这是 Europe PMC 的入库节奏，不是 bug。所以标题写「最新推送」而非「今日推送」。
- **影响因子是 2024 JCR 近似值**，只用于星级分级和排序权重，不要当引用依据；展开卡片会显示精确数值。
- **「今日精选」是启发式排序，不是 LLM 精读**。任务文档里的「创新 / 看点」需要模型读摘要才能写，静态前端做不到——因此只呈现**摘要原文的分段**（目的/方法/结果/结论），**不生成任何摘要里没有的结论**，符合文档「不得编造」的硬性约束。
- **基础/分子论文**判定依据是期刊名（Cell / Nature / Science / Neuron / JACC: Basic 片段），与任务文档一致。
- 上游波动时页面自动回落到 `data/snapshot-*.json` 并给出提示。

## 版本更新按钮

页面底部有一个 **「版本 2026.10.01」** 按钮：

- 点一下 → 注销 Service Worker、清空所有缓存、带 cache-busting 参数重新加载，**强制拉取最新版本**
- Service Worker 检测到新版本时会**自动高亮**（变黄 + 呼吸光圈 + 「发现新版本 · 点此更新」），每 30 分钟自动查一次
- 改前端资源时记得同步 bump `assets/app.js` 的 `APP_VERSION` 和 `sw.js` 的 `V`（缓存名）
