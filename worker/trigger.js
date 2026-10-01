/**
 * 科研雷达 · 触发 Worker
 * ───────────────────────────────────────────────────────────────
 * 前端点「🔁 重新生成」→ 这个 Worker 用 GitHub PAT 调用两个 workflow_dispatch，
 * 让 GitHub Actions 重新跑一遍，生成最新的 data/digest.json 与 data/snapshot-*.json。
 *
 * 这样你不用开电脑、不用去仓库点 Run workflow，手机上点一下就能让每日数据重算。
 *
 * 部署（在装有 wrangler 的机器上，国内部署需科学上网 / VPN）：
 *   1) 在 GitHub 生成 fine-grained PAT：仅对 robinmarie628/research-radar
 *      授予 Repository permissions → Actions = Read and write，复制下来。
 *   2) npx wrangler secret put GITHUB_PAT        （把上一步的 PAT 粘进去）
 *   3) npx wrangler deploy
 *   4) 记下输出的 *.workers.dev 地址，填进前端 assets/app.js 的 WORKER_URL。
 *
 * 详见同目录 README-deploy.md
 */

const REPO = 'robinmarie628/research-radar';
const WORKFLOWS = ['daily-digest.yml', 'refresh-snapshots.yml'];
const GH_API = 'https://api.github.com';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

export default {
  async fetch(request, env) {
    // 浏览器跨域 POST 会先发一个 OPTIONS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: '只接受 POST 请求' }, 405);
    }

    const pat = env.GITHUB_PAT;
    if (!pat) {
      return json({ ok: false, error: 'Worker 未配置 GITHUB_PAT' }, 500);
    }

    const results = [];
    for (const wf of WORKFLOWS) {
      const url = `${GH_API}/repos/${REPO}/actions/workflows/${wf}/dispatches`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'research-radar-trigger',
          },
          body: JSON.stringify({ ref: 'main' }),
        });
        // GitHub 成功返回 204 No Content
        results.push({ workflow: wf, ok: r.status === 204, status: r.status });
      } catch (e) {
        results.push({ workflow: wf, ok: false, error: String(e) });
      }
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length === 0) {
      return json({ ok: true, results }, 200);
    }
    return json({ ok: false, results, failed }, 502);
  },
};
