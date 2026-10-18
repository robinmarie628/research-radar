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
 * mode "quotes"    — 3 or 4 verbatim excerpts plus Chinese, for the share card
 * Drug names are masked as [D1]… before the model call and restored after.
 * Results are cached in the Cache API keyed by the English text.
 */
import {
  MT_MODEL, TITLE_SYSTEM, SELECTION_SYSTEM, TITLE_BATCH, DEFAULT_OVERRIDES,
  SELECTION_MAX, TITLE_MAX,
  maskDrugs, restoreDrugs, applyGlossary, parseTranslationArray, isTranslatedZh, stripTitleStop,
  extractAiText, isQuotaError, normTitle, sha256Hex,
} from '../_lib/mt.js';
import {
  QUOTE_SYSTEM, ABSTRACT_MAX, splitSentences, resolveQuotePicks, parseQuoteResponse,
  selectQuotePool,
} from '../_lib/quotes.js';
import { openAccessPassages } from '../_lib/fulltext.js';

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
    if (hit?.zh) out[i] = { id: clean[i].id, zh: stripTitleStop(hit.zh), cached: true };
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
    const zh = stripTitleStop(applyGlossary(
      clean[i].text,
      restoreDrugs(parts[j], masked[j].drugs),
      glossary,
      overrides,
    ));
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
  if (body.mode === 'quotes') return translateQuotes(request, env, body);
  return json({ error: 'bad_mode' }, 400);
}

async function translateQuotes(request, env, body) {
  const abstract = String(body.abstract || '').replace(/\s+/g, ' ').trim();
  if (!abstract) {
    return json({ error: 'empty', message: '这篇没有英文摘要，做不了摘句卡片。' }, 400);
  }
  if (abstract.length > ABSTRACT_MAX) {
    return json({ error: 'too_long', message: '摘要太长了，暂时做不了摘句卡片。' }, 400);
  }
  const sentences = splitSentences(abstract);
  if (!sentences.length) {
    return json({ error: 'empty', message: '摘要里没有可用的句子。' }, 400);
  }

  const { glossary, overrides } = await loadResources(request, env);
  const sections = body.sections && typeof body.sections === 'object' ? body.sections : null;
  const doi = String(body.doi || body.id || '');
  const key = 'quotes/v15/' + (await sha256Hex(normTitle(abstract) + '|' + doi.toLowerCase())).slice(0, 32);
  const hit = await cacheGet(request, key);
  if (hit?.quotes?.length) return json({ quotes: hit.quotes, cached: true });

  let passage = '';
  let oaStatus = 'none';
  if (/^10\.\d{4,}\//.test(doi)) {
    const oa = await openAccessPassages(doi);
    oaStatus = oa.status;
    passage = oa.text || '';
  }
  const corpus = passage ? abstract + '\n' + passage : abstract;
  const pool = quotePool(corpus);

  let picks = [];
  try {
    const listing = pool.map((s, i) => '[' + i + '] ' + maskDrugs(s).text).join('\n');
    const raw = await runModel(env, QUOTE_SYSTEM, listing, 2000);
    const restored = parseQuoteResponse(raw).map(q => {
      const i = Number(q.i);
      const en = Number.isInteger(i) && pool[i] ? pool[i] : '';
      let zh = q.zh || '';
      if (en && zh) {
        zh = applyGlossary(en, restoreDrugs(zh, maskDrugs(en).drugs), glossary, overrides);
      }
      if (!isTranslatedZh(en, zh)) zh = '';
      return { i: q.i, role: q.role, en: q.en, zh };
    });
    picks = resolveQuotePicks(pool.join(' '), restored, sections);
  } catch (err) {
    if (err?.code === 'quota' || isQuotaError(err) || err?.code === 'ai_unconfigured') return fail(err);
    picks = resolveQuotePicks(pool.join(' '), [], sections);
  }

  for (const p of picks) {
    const parts = p.pieces?.length ? p.pieces : [p];
    for (const part of parts) if (!isTranslatedZh(part.en, part.zh)) part.zh = '';
  }
  const missingZh = () => {
    const jobs = [];
    for (const p of picks) {
      const parts = p.pieces?.length ? p.pieces : [p];
      for (const part of parts) if (!isTranslatedZh(part.en, part.zh)) jobs.push(part);
    }
    return jobs;
  };
  let translateErr = null;
  for (let attempt = 0; attempt < 2 && missingZh().length; attempt++) {
    const jobs = missingZh();
    try {
      const masked = jobs.map(p => maskDrugs(p.en));
      const raw = await runModel(
        env,
        SELECTION_SYSTEM + '\nYou will receive a JSON array of excerpts. Reply with a JSON array of Simplified Chinese translations, same length and order, and nothing else. If an excerpt begins or ends with the ellipsis …, keep … at the same end of the Chinese line and translate only the words that are present. Do not add an ellipsis that was not in the excerpt. Never copy an English sentence into the answer.',
        JSON.stringify(masked.map(m => m.text)),
        2000,
      );
      const parts = parseTranslationArray(raw, jobs.length);
      jobs.forEach((p, j) => {
        const zh = applyGlossary(p.en, restoreDrugs(parts[j], masked[j].drugs), glossary, overrides);
        if (isTranslatedZh(p.en, zh)) p.zh = zh;
      });
    } catch (err) {
      translateErr = err;
      if (err?.code === 'quota' || isQuotaError(err) || err?.code === 'ai_unconfigured') return fail(err);
    }
  }
  picks = picks.filter(p => {
    if (p.pieces?.length) {
      p.pieces = p.pieces.filter(part => isTranslatedZh(part.en, part.zh));
      if (!p.pieces.length) return false;
      p.en = p.pieces.map(part => part.en).join(' … ');
      p.zh = p.pieces.map(part => alignEllipsis(part.en, part.zh)).join(' … ');
      return true;
    }
    return isTranslatedZh(p.en, p.zh);
  });
  if (!picks.length) return fail(translateErr || Object.assign(new Error('untranslated'), { code: 'ai_failed' }));
  for (const p of picks) {
    if (p.pieces?.length) {
      const ready = p.pieces.filter(part => part.en && part.zh);
      p.pieces = ready;
      p.en = ready.map(part => part.en).join(' … ');
      p.zh = ready.map(part => alignEllipsis(part.en, part.zh)).join(' … ');
    } else if (p.zh) {
      p.zh = alignEllipsis(p.en, p.zh);
    }
  }

  const quotes = picks.filter(p => p.en && p.zh).slice(0, 4).map(p => {
    const sentence = p.sentence || '';
    const sentences = p.pieces?.length
      ? p.pieces.map(part => part.sentence).filter(Boolean)
      : (sentence ? [sentence] : []);
    const fromFull = sentences.some(s => passage && !abstract.includes(String(s).replace(/[.。]+$/, '').trim()));
    return {
      role: p.role || '',
      en: p.en,
      zh: p.zh,
      sentence,
      sentences,
      source: fromFull ? 'fulltext' : 'abstract',
    };
  });
  if (!quotes.length) return json({ error: 'ai_failed', message: '摘句翻译失败，请再试一次。' }, 502);
  if (oaStatus !== 'error') await cachePut(request, key, { quotes });
  return json({ quotes, cached: false, source: passage ? 'fulltext' : 'abstract' });
}

function quotePool(text) {
  return selectQuotePool(text);
}

function alignEllipsis(en, zh) {
  let z = String(zh || '').trim().replace(/\.{3,}/g, '…');
  z = z.replace(/^…+/, '').replace(/…+$/, '').trim();
  if (String(en || '').startsWith('…')) z = '…' + z;
  if (String(en || '').endsWith('…')) z += '…';
  return z;
}

export function onRequest(context) {
  return handleTranslate(context.request, context.env || {});
}
