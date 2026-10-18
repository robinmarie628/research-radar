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
commit) triggers a new deploy automatically. Non-main branches get a Pages preview URL.

## Workers AI binding (机翻标题 / 划词翻译)

`functions/api/translate.js` calls Workers AI as `env.AI`. The binding is declared in
the repo-root `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

Model: `@cf/qwen/qwen3-30b-a3b-fp8`, thinking off (`/no_think`), temperature 0.1.
A preview deploy of a branch that contains that file should receive the binding.
`wrangler.toml` becomes the Pages source of truth for bindings once Pages accepts it
(`pages_build_output_dir` is set). This project had no dashboard bindings.

If a deploy's `POST /api/translate` still returns `503` with `error: "ai_unconfigured"`,
add the binding by hand and redeploy:

1. Workers & Pages → **research-radar-f5j** → **Settings** → **Bindings** → **Add** → **Workers AI**.
2. Variable name: **`AI`** (exact).
3. Add it for **both Production and Preview**.
4. Retry the deployment.

Seeded titles in `data/title-zh.json` still show without the binding. Only uncached titles
and the tap-to-translate popup need `env.AI`. The account is Workers Free (10k neurons/day);
a quota error is shown in the popup and is not billed.

## Verify

- Open `https://research-radar.pages.dev` — the app should load.
- Open `https://research-radar.pages.dev/data/digest.json` and check the `generatedAt` field;
  after a daily run it should be today's timestamp.
- In **Deployments**, confirm the latest deploy was triggered by `chore: daily digest` /
  `chore: refresh snapshots` and is green.

## Notes

- **收藏**：页面上点「下载 Markdown」。发到邮箱要自有域名上的 Cloudflare Email Routing；目前没有自定义域名，所以不走发信，也不用在 Dashboard 配 Email。

- **Build limit**: the free plan allows 500 builds/month. Two bot commits a day is ~60/month.
- **Deploy lag**: a push takes ~1 minute to go live. The app's live fetches (Europe PMC,
  follow-builders) update on page open regardless; only the committed JSONs need the redeploy.
- **Mainland China**: `*.pages.dev` is not reliably reachable without a VPN. Bind a custom
  domain in **Custom domains** if you need better access.
- GitHub Pages can stay enabled as a fallback; both hosts read the same repo.
