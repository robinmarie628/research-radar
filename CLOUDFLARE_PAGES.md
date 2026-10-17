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

## Notes

- **Build limit**: the free plan allows 500 builds/month. Two bot commits a day is ~60/month.
- **Deploy lag**: a push takes ~1 minute to go live. The app's live fetches (Europe PMC,
  follow-builders) update on page open regardless; only the committed JSONs need the redeploy.
- **Mainland China**: `*.pages.dev` is not reliably reachable without a VPN. Bind a custom
  domain in **Custom domains** if you need better access.
- GitHub Pages can stay enabled as a fallback; both hosts read the same repo.
