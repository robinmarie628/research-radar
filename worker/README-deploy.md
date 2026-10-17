# 科研雷达 · 触发 Worker 部署指南

前端「🔁 重新生成」按钮会请求这个 Cloudflare Worker，由它代替你手动去 GitHub 点
`Run workflow`，把每日摘要 / 快照重新算一遍。你不开电脑、只在手机上，点一下就能触发。

> 注意：Cloudflare 的 `*.workers.dev` 域名在**中国大陆默认被墙**，需要科学上网 / VPN 才能访问。
> 你之前说过可以挂 VPN，所以直接用 `workers.dev` 地址即可。若想在国内无 VPN 也能点
> （比如给同事用），可在 Cloudflare 给这个 Worker **绑定一个自定义域名**（你自己的域名），
> 那样就不依赖 workers.dev 了。

---

## 方式 A（推荐，最简单）：纯网页部署，不用装任何软件

不需要装 Node、npm、wrangler，全程在浏览器里点。

1. 登录 <https://dash.cloudflare.com>（没有账号先免费注册）
2. 左侧 **Workers & Pages** → **Create** → 选 **Create Worker**
3. Worker 名字填 `research-radar-trigger` → **Deploy**（先随便部署一版占位）
4. 部署后点 **Edit code**，把编辑器里的示例代码**全部删掉**，
   粘贴 `trigger.js` 的完整内容 → **Save**
5. 点 **Settings** → **Variables** → **Add variable**：
   - Name：`GITHUB_PAT`
   - Value：粘贴下面「生成 PAT」那一步拿到的口令
   - 勾选 **Encrypt**（设为 Secret）→ **Add**
6. 回到代码页 **Redeploy**（或 Deploy）让变量生效
7. 部署完成会显示地址 `https://research-radar-trigger.<子域>.workers.dev`，**复制它**

拿到地址后跳到「步骤 4 — 把地址填进前端」。

## 方式 B：wrangler 命令行（如果你本就装了 Node）

（见下方「步骤 2 / 3」）

---

## 步骤 1 — 在 GitHub 生成一个 PAT

用**细粒度 PAT（fine-grained）**，权限最小、最安全：

1. 打开 <https://github.com/settings/tokens?type=beta>
2. 点 **Generate new token (fine-grained)**
3. Token name 随便填，例如 `research-radar-trigger`
4. Resource owner 选 **robinmarie628**
5. Repository access → **Only select repositories** → 选 **research-radar**
6. Repository permissions → **Actions** → 选 **Read and write**
7. （其余保持默认）点 **Generate token**
8. **立刻复制**那串 `github_pat_xxx`（只显示一次）

> 经典 PAT 也行：勾选 `repo` 权限即可，但细粒度更干净，推荐细粒度。

## 步骤 2 — 准备 wrangler

在任意一台**能科学上网**的电脑上（Windows / macOS 都行）：

```bash
npm install -g wrangler        # 或 npx wrangler
wrangler whoami                # 第一次会让你登录 Cloudflare，按提示走
```

## 步骤 3 — 把这个目录部署上去

```bash
cd research-radar/worker
npx wrangler secret put GITHUB_PAT      # 粘贴步骤 1 复制的 PAT
npx wrangler deploy
```

部署成功后会输出一个地址，形如：

```
https://research-radar-trigger.<你的子域>.workers.dev
```

## 步骤 4 — 把地址填进前端

打开 `research-radar/assets/app.js`，找到这一行：

```js
const WORKER_URL = 'https://REPLACE-ME.workers.dev';
```

把 `https://REPLACE-ME.workers.dev` 换成拿到的真实地址（方式 A 是第 7 步、方式 B 是步骤 3）。

然后要**先提交、再推送**（`.bat` 只负责推送，不负责提交）：
- 用 **GitHub Desktop**（图形界面，点一下 Commit）或命令：
  `git add assets/app.js && git commit -m "set worker url"`
- 再**双击 `push-research-radar.bat`** 推上去

（如果绑定了自定义域名，就填你的自定义域名。）

---

## 使用时

手机打开科研雷达 → 滚到底部 → 点 **🔁 重新生成** → 提示「已触发」后，
等 **1–2 分钟**（GitHub 跑完两个 workflow 并提交） → 点右上角 **🔄** 刷新，
就能看到新生成的今日精选 / 摘要。

## 收藏邮件（POST /favorites）

`POST /` 仍然只触发 GitHub Actions。`POST /favorites` 把收藏 Markdown 发给
**robinmarie628@gmail.com**，收件人写死在 `favorites-mail.js`，请求体里的 `to` 如果不是这个地址会被拒绝。

`wrangler.toml` 里已经有：

```toml
[[send_email]]
name = "EMAIL"
destination_address = "robinmarie628@gmail.com"

[observability]
enabled = true

[observability.traces]
enabled = true
```

`destination_address` 让这个绑定只能发给这一个已验证地址（Workers Free 的免费路径）。

部署前还要：

1. Dashboard → **Compute → Email Service → Email Routing → Destination addresses**，添加 `robinmarie628@gmail.com`，并在 Gmail 里点验证链接。
2. 在同一个 Email Routing 页面 **Onboard Domain**，用你自己的、DNS 在 Cloudflare 的域名。发件地址必须落在这个域名上。
3. 给 Worker 加纯文本变量 `EMAIL_FROM`，例如 `Radar for Meds <favorites@yourdomain.com>`。不要写成 Gmail，也不要写进 Secret。
4. `npx wrangler deploy`。compatibility date 已是 `2026-10-17`。

Pages 项目上的同一套步骤见仓库根目录 `CLOUDFLARE_PAGES.md`。页面会先请求 `/api/favorites`，再回落到这个 Worker。

## 排查

- 按钮提示「未配置 Worker 地址」→ `WORKER_URL` 还是 `REPLACE-ME`，没替换。
- 按钮提示「触发失败」→ 多半是 PAT 过期 / 权限不对；去 GitHub 重新生成一个
  `actions:write` 的 PAT，再用 `wrangler secret put GITHUB_PAT` 覆盖，重新 `wrangler deploy`。
- 一直连不上 workers.dev → 确认手机当前挂着 VPN；或给 Worker 绑自定义域名。
- 触发成功但数据没变 → workflow 还在跑，或者 `main` 分支没更新；等一两分钟再点 🔄。
