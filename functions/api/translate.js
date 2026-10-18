/**
 * Pages Function: POST /api/translate
 *
 * Binding: env.AI  (Workers AI). Declared in the repo-root wrangler.toml.
 * If a deploy still has no binding, this returns 503 { error: "ai_unconfigured" }.
 * Dashboard fallback (both Production and Preview):
 *   Workers & Pages → this Pages project → Settings → Bindings → Add → Workers AI
 *   Variable name: AI
 *   Then redeploy.
 *
 * mode "titles"    — up to 10 titles, qwen3 system prompt, JSON array back
 * mode "selection" — one highlighted span, short medical prompt
 * Drug names are masked as [D1]… before the model call and restored after.
 * Results are cached in the Cache API keyed by the English text.
 */
import {
  MT_MODEL, TITLE_SYSTEM, SELECTION_SYSTEM, TITLE_BATCH, DEFAULT_OVERRIDES,
  SELECTION_MAX, TITLE_MAX,
  maskDrugs, restoreDrugs, applyGlossary, parseTranslationArray,
  extractAiText, isQuotaError, normTitle, sha256Hex,
} from '../_lib/mt.js';

const CACHE_PREFIX = 'v1';

let resourceCache = null;
/** @type {{ glossary: any[], overrides: any[] } | null} */
let testResources = null;

export function __setMtResources(resources) {
  testResources = resources;
  resourceCache = null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function quotaBody() {
  return { error: 'quota', message: '今天的免费翻译额度用完了，明天会恢复。' };
}

function edgeCache() {
  try { return globalThis.caches?.default || null; }
  catch { return null; }
}

function cacheRequest(request, key) {
  const u = new URL(request.url);
  u.pathname = `/api/mt-cache/${CACHE_PREFIX}/${key}`;
  u.search = '';
  return new Request(u.toString(), { method: 'GET' });
}

async function cacheGet(request, key) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(cacheRequest(request, key));
    if (!hit) return null;
    return await hit.json();
  } catch { return null; }
}

async function cachePut(request, key, data) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(cacheRequest(request, key), new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=31536000',
      },
    }));
  } catch { /* cache is best-effort; the client also stores the result */ }
}

async function loadResources(request, env) {
  if (testResources) return testResources;
  if (resourceCache) return resourceCache;
  const load = async (path) => {
    const url = new URL(path, request.url);
    try {
      const res = env?.ASSETS?.fetch
        ? await env.ASSETS.fetch(new Request(url))
        : await fetch(url);
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  };
  const [glossary, overrides] = await Promise.all([
    load('/data/glossary.json'),
    load('/data/mt-overrides.json'),
  ]);
  resourceCache = {
    glossary: Array.isArray(glossary) ? glossary : [],
    overrides: Array.isArray(overrides) && overrides.length ? overrides : DEFAULT_OVERRIDES,
  };
  return resourceCache;
}

function assertAi(env) {
  if (!env?.AI || typeof env.AI.run !== 'function') {
    const err = new Error('ai_unconfigured');
    err.code = 'ai_unconfigured';
    throw err;
  }
}

async function runModel(env, system, user, maxTokens) {
  assertAi(env);
  let result;
  try {
    result = await env.AI.run(MT_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '/no_think\n' + user },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    });
  } catch (err) {
    if (isQuotaError(err)) {
      const e = new Error('quota');
      e.code = 'quota';
      throw e;
    }
    throw err;
  }
  if (result && result.success === false) {
    const msg = JSON.stringify(result.errors || result);
    if (isQuotaError(msg)) {
      const e = new Error('quota');
      e.code = 'quota';
      throw e;
    }
    const e = new Error(msg);
    e.code = 'ai_failed';
    throw e;
  }
  const text = extractAiText(result);
  if (!text) {
    const e = new Error('empty');
    e.code = 'bad_model';
    throw e;
  }
  if (isQuotaError(text)) {
    const e = new Error('quota');
    e.code = 'quota';
    throw e;
  }
  return text;
}

function fail(err) {
  if (err?.code === 'quota' || isQuotaError(err)) return json(quotaBody(), 429);
  if (err?.code === 'ai_unconfigured') {
    return json({ error: 'ai_unconfigured', message: '翻译服务还没准备好，稍后再试。' }, 503);
  }
  return json({ error: 'ai_failed', message: '翻译失败，请再试一次。' }, 502);
}

async function translateSelection(request, env, body) {
  const text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return json({ error: 'empty' }, 400);
  if (text.length > SELECTION_MAX) {
    return json({
      error: 'too_long',
      message: `选中的文字太长了（最多 ${SELECTION_MAX} 字），请缩短后再试。`,
    }, 400);
  }
  const { glossary, overrides } = await loadResources(request, env);
  const key = 'sel/' + (await sha256Hex(normTitle(text))).slice(0, 32);
  const hit = await cacheGet(request, key);
  if (hit?.zh) return json({ zh: hit.zh, cached: true });

  const masked = maskDrugs(text);
  let raw;
  try {
    raw = await runModel(env, SELECTION_SYSTEM, masked.text, 2000);
  } catch (err) { return fail(err); }
  let zh = restoreDrugs(raw, masked.drugs);
  zh = applyGlossary(text, zh, glossary, overrides).replace(/\s+/g, ' ').trim();
  if (!zh) return json({ error: 'ai_failed', message: '翻译失败，请再试一次。' }, 502);
  await cachePut(request, key, { zh });
  return json({ zh, cached: false });
}

async function translateTitles(request, env, body) {
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) return json({ error: 'bad_items' }, 400);
  if (items.length > TITLE_BATCH) return json({ error: 'batch', message: '一次最多 10 条标题。' }, 400);
  const clean = [];
  for (const it of items) {
    const id = String(it?.id || '').trim();
    const text = String(it?.text || '').replace(/\s+/g, ' ').trim();
    if (!id || !text) return json({ error: 'bad_items' }, 400);
    if (text.length > TITLE_MAX) return json({ error: 'too_long', message: '有一条标题太长了。' }, 400);
    clean.push({ id, text });
  }
  if (!clean.length) return json({ items: [] });

  const { glossary, overrides } = await loadResources(request, env);
  const out = new Array(clean.length);
  const pending = [];
  for (let i = 0; i < clean.length; i++) {
    const key = 'title/' + (await sha256Hex(normTitle(clean[i].text))).slice(0, 32);
    const hit = await cacheGet(request, key);
    if (hit?.zh) out[i] = { id: clean[i].id, zh: hit.zh, cached: true };
    else pending.push(i);
  }
  if (!pending.length) return json({ items: out });

  const masked = pending.map(i => maskDrugs(clean[i].text));
  let parts;
  try {
    const raw = await runModel(
      env,
      TITLE_SYSTEM,
      JSON.stringify(masked.map(m => m.text)),
      2000,
    );
    parts = parseTranslationArray(raw, pending.length);
  } catch (err) {
    if (out.some(Boolean)) {
      return json({
        items: out.filter(Boolean),
        ...(err?.code === 'quota' || isQuotaError(err) ? quotaBody() : { error: 'ai_failed' }),
      }, err?.code === 'ai_unconfigured' ? 503 : 200);
    }
    return fail(err);
  }

  for (let j = 0; j < pending.length; j++) {
    const i = pending[j];
    const zh = applyGlossary(
      clean[i].text,
      restoreDrugs(parts[j], masked[j].drugs),
      glossary,
      overrides,
    );
    out[i] = { id: clean[i].id, zh, cached: false };
    const key = 'title/' + (await sha256Hex(normTitle(clean[i].text))).slice(0, 32);
    await cachePut(request, key, { zh });
  }
  return json({ items: out });
}

export async function handleTranslate(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== 'null' && origin !== url.origin) return json({ error: 'forbidden' }, 403);
  if (!origin) {
    const ref = request.headers.get('Referer') || '';
    if (ref && !ref.startsWith(url.origin)) return json({ error: 'forbidden' }, 403);
  }
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 20000) {
      return json({ error: 'too_long', message: '选中的文字太长了，请缩短后再试。' }, 413);
    }
    body = JSON.parse(raw || '{}');
  } catch {
    return json({ error: 'bad_json' }, 400);
  }
  if (body.mode === 'selection') return translateSelection(request, env, body);
  if (body.mode === 'titles') return translateTitles(request, env, body);
  return json({ error: 'bad_mode' }, 400);
}

export function onRequest(context) {
  return handleTranslate(context.request, context.env || {});
}
