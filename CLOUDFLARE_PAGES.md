# Deploy to Cloudflare Pages (Git integration)

The site is a zero-build static app. Cloudflare Pages connects directly to this repo and
redeploys on every push to `main` — including the bot's daily data commits.

## What is already set up in this repo

| File | Purpose |
|---|---|
| `_headers` | Tells Pages not to edge-cache `data/*.json`, `sw.js` or `index.html`, so a new deploy is visible immediately. |
| `scripts/pages-build.sh` | Stages only the site files (`index.html`, `manifest.webmanifest`, `sw.js`, `assets/`, `data/`, `_headers`) into `dist/`. Keeps `scripts/`, `worker/` and docs off the public site. |
| `.gitignore` | Ignores the generated `dist/`. |
| workflows | Commit messages no longer carry `[skip ci]` — Cloudflare Pages honours that token and would **skip the deploy**, freezing the site on old data. |

## Dashboard steps

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Authorise GitHub if prompted, then select **`robinmarie628/research-radar`**.
3. Project name: `research-radar` → the site will be at `https://research-radar.pages.dev`.
4. **Production branch**: `main`.
5. **Framework preset**: `None`.
6. **Build command**: `bash scripts/pages-build.sh`
7. **Build output directory**: `dist`
8. Leave environment variables empty. Click **Save and Deploy**.

The first deploy takes ~1 minute. After that, every push to `main` (including the daily bot
commit) triggers a new deploy automatically.

## Verify

- Open `https://research-radar.pages.dev` — the app should load.
- Open `https://research-radar.pages.dev/data/digest.json` and check the `generatedAt` field;
  after a daily run it should be today's timestamp.
- In **Deployments**, confirm the latest deploy was triggered by `chore: daily digest` /
  `chore: refresh snapshots` and is green.

## 收藏邮件（只发给 robinmarie628@gmail.com）

页面上的「发送到邮箱」把收藏清单做成 Markdown，交给 Cloudflare 发出去。浏览器里没有发信密钥，也不能改收件人。

同一套逻辑有两个入口，页面会先打同源的 Pages Function，失败再打已经在用的 trigger Worker：

| 入口 | 地址 |
|---|---|
| Pages Function | `POST /api/favorites`（`functions/api/favorites.js`） |
| trigger Worker | `POST https://research-radar-trigger.robinmarie628.workers.dev/favorites` |

`functions/` 留在仓库根目录。Pages 会单独编译它，**不要**把它拷进 `dist/`。

收件人写死为 `robinmarie628@gmail.com`。绑定再用 `destination_address` 锁一次，所以就算代码被改错，Cloudflare 也不会把信发给别人。这是 Workers Free 上「发给已验证地址」的免费路径，不需要 Workers Paid，也不要开通面向任意收件人的 Email Sending。

### 你要在 Dashboard 做的一次性设置

1. **验证收件箱。** [Email Routing → Destination addresses](https://dash.cloudflare.com/?to=/:account/email-service/routing) → 填 `robinmarie628@gmail.com` → 提交。打开 Gmail 里的验证信，点 **Verify email address**。没点之前绑定是不会投递的。
2. **准备发件域名。** 免费路径只能从「已经开通 Email Routing 的你自己的域名」发信。在 **Compute → Email Service → Email Routing** 里 **Onboard Domain**，选账号里由 Cloudflare DNS 托管的域名，让它写入 MX / SPF / DKIM。`from` 必须是这个域名上的地址，例如 `favorites@yourdomain.com`。`pages.dev` 不能当发件域。如果账号里还没有自己的域名，这一步完成前按钮会返回 503，信发不出去。
3. **给 Pages 项目加绑定。** Workers & Pages → 这个 Pages 项目（线上是 `research-radar-f5j`）→ **Settings → Bindings → Add → Send email**：
   - Variable name：`EMAIL`
   - Destination address：`robinmarie628@gmail.com`
   - 生产环境和预览环境都加上
4. **发件地址变量（不是 Secret）。** 同一页 **Variables** 增加纯文本变量：
   - Name：`EMAIL_FROM`
   - Value：`Radar for Meds <favorites@yourdomain.com>`（换成第 2 步那个域名）
5. **Compatibility date** 设为 `2026-10-17` 或更新（Settings → Runtime）。旧日期不认识 `env.EMAIL.send({ to, from, subject, text })` 这种写法。
6. **重新部署**一次 Pages，绑定才会进当前版本。

Worker 那条备用路径的绑定写在 `worker/wrangler.toml`（`[[send_email]]`，`destination_address = "robinmarie628@gmail.com"`）。部署前在 toml 里没有默认 `EMAIL_FROM`，请用：

```bash
cd worker
npx wrangler deploy
# 然后在 Dashboard 给这个 Worker 加纯文本变量 EMAIL_FROM，或在 wrangler.toml 的 [vars] 里写上再部署
```

不要把 Gmail 地址写进 `EMAIL_FROM`。`GITHUB_PAT` 仍然只放 Secret，不要进仓库。

本地 `http://127.0.0.1` 没有绑定时，接口返回 `dryRun: true` 和 Markdown，页面弹出「未发送」预览，不会真的发信。用静态文件服务打开时接口是 404，按钮同样只给本地预览。

限制：一次最多 40 篇，正文约 180 KB，同一 IP 10 分钟最多 5 次。

## Notes

- **Build limit**: the free plan allows 500 builds/month. Two bot commits a day is ~60/month.
- **Deploy lag**: a push takes ~1 minute to go live. The app's live fetches (Europe PMC,
  follow-builders) update on page open regardless; only the committed JSONs need the redeploy.
- **Mainland China**: `*.pages.dev` is not reliably reachable without a VPN. Bind a custom
  domain in **Custom domains** if you need better access.
- GitHub Pages can stay enabled as a fallback; both hosts read the same repo.
