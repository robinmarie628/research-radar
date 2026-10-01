# 科研雷达 · 触发 Worker 部署指南

前端「🔁 重新生成」按钮会请求这个 Cloudflare Worker，由它代替你手动去 GitHub 点
`Run workflow`，把每日摘要 / 快照重新算一遍。你不开电脑、只在手机上，点一下就能触发。

> 注意：Cloudflare 的 `*.workers.dev` 域名在**中国大陆默认被墙**，需要科学上网 / VPN 才能访问。
> 你之前说过可以挂 VPN，所以直接用 `workers.dev` 地址即可。若想在国内无 VPN 也能点
> （比如给同事用），可在 Cloudflare 给这个 Worker **绑定一个自定义域名**（你自己的域名），
> 那样就不依赖 workers.dev 了。

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

把 `https://REPLACE-ME.workers.dev` 换成步骤 3 拿到的真实地址。然后像平时一样
用 `push-research-radar.bat` 推上去即可。

（如果绑定了自定义域名，就填你的自定义域名。）

---

## 使用时

手机打开科研雷达 → 滚到底部 → 点 **🔁 重新生成** → 提示「已触发」后，
等 **1–2 分钟**（GitHub 跑完两个 workflow 并提交） → 点右上角 **🔄** 刷新，
就能看到新生成的今日精选 / 摘要。

## 排查

- 按钮提示「未配置 Worker 地址」→ `WORKER_URL` 还是 `REPLACE-ME`，没替换。
- 按钮提示「触发失败」→ 多半是 PAT 过期 / 权限不对；去 GitHub 重新生成一个
  `actions:write` 的 PAT，再用 `wrangler secret put GITHUB_PAT` 覆盖，重新 `wrangler deploy`。
- 一直连不上 workers.dev → 确认手机当前挂着 VPN；或给 Worker 绑自定义域名。
- 触发成功但数据没变 → workflow 还在跑，或者 `main` 分支没更新；等一两分钟再点 🔄。
