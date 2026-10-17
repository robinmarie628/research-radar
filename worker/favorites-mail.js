/**
 * Email the favorites list to one verified destination.
 *
 * Recipient is fixed in this file. The client cannot choose an address.
 * Delivery uses the Workers `send_email` binding (env.EMAIL), restricted
 * with `destination_address` so Cloudflare also refuses any other recipient.
 * Sends to a verified Email Routing destination are free on Workers Free.
 *
 * If the binding is missing, localhost and EMAIL_DRY_RUN=1 return the
 * Markdown without sending. A public host without the binding returns 503.
 */

export const RECIPIENT = 'robinmarie628@gmail.com';

const MAX_ITEMS = 40;
const MAX_TITLE = 500;
const MAX_ABSTRACT = 4000;
const MAX_JOURNAL = 160;
const MAX_DOI = 200;
const MAX_BODY_BYTES = 180_000;
const MAX_MARKDOWN = 100_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

/** Timestamps only, keyed by IP. Not request bodies. */
const rateHits = new Map();

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
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

export function mailDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function cleanLine(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanBlock(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, max);
}

/** DOI token only. Returns '' when absent, null when present but not a DOI. */
export function normalizeDoi(raw) {
  let s = cleanLine(raw, MAX_DOI);
  if (!s) return '';
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  if (!/^10\.\d{4,9}\/\S+$/i.test(s)) return null;
  return s;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function validateFavoritesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  if (body.to != null && String(body.to).trim().toLowerCase() !== RECIPIENT) {
    return { error: '收件人已固定，不能改成别的地址' };
  }
  if (body.recipient != null && String(body.recipient).trim().toLowerCase() !== RECIPIENT) {
    return { error: '收件人已固定，不能改成别的地址' };
  }
  if (!Array.isArray(body.items)) return { error: '缺少 items 数组' };
  if (!body.items.length) return { error: '收藏是空的' };
  if (body.items.length > MAX_ITEMS) return { error: `一次最多发送 ${MAX_ITEMS} 篇` };

  const items = [];
  for (let i = 0; i < body.items.length; i++) {
    const raw = body.items[i];
    if (!raw || typeof raw !== 'object') return { error: `第 ${i + 1} 条不是对象` };
    const title = cleanLine(raw.title, MAX_TITLE);
    if (!title) return { error: `第 ${i + 1} 条缺少标题` };
    const titleEn = cleanLine(raw.titleEn, MAX_TITLE);
    const journal = cleanLine(raw.journal, MAX_JOURNAL);
    const abstract = cleanBlock(raw.abstract, MAX_ABSTRACT);
    const doi = normalizeDoi(raw.doi);
    if (doi === null) return { error: `第 ${i + 1} 条 DOI 格式不对` };
    items.push({ title, titleEn, journal, abstract, doi });
  }
  return { items };
}

export function buildFavoritesMail(items, now = new Date()) {
  const date = mailDate(now);
  const subject = `Radar for Meds 收藏 · ${date}`;
  const lines = [
    '# Radar for Meds 收藏',
    '',
    `${date} · ${items.length} 篇`,
    '',
    '这份清单从浏览器本地收藏生成，只发给已验证的收件箱。',
    '',
  ];
  items.forEach((item, i) => {
    lines.push('---', '', `## ${i + 1}. ${item.title}`, '');
    if (item.titleEn && item.titleEn !== item.title) {
      lines.push(item.titleEn, '');
    }
    if (item.journal) lines.push(`- 期刊：${item.journal}`);
    lines.push(`- DOI：${item.doi ? `https://doi.org/${item.doi}` : '无'}`, '');
    lines.push(item.abstract || '（没有摘要）', '');
  });
  let markdown = lines.join('\n').trim() + '\n';
  if (markdown.length > MAX_MARKDOWN) {
    markdown = markdown.slice(0, MAX_MARKDOWN - 20).trimEnd() + '\n\n…（已截断）\n';
  }
  const filename = `radar-for-meds-favorites-${date}.md`;
  const html = `<pre style="white-space:pre-wrap;font-family:ui-sans-serif,sans-serif">${escapeHtml(markdown)}</pre>`;
  return { subject, markdown, html, filename, date };
}

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function allowDryRun(request, env) {
  if (String(env.EMAIL_DRY_RUN || '') === '1') return true;
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
    || 'local';
}

function withinRate(ip) {
  const now = Date.now();
  const recent = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    rateHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateHits.set(ip, recent);
  if (rateHits.size > 4000) {
    for (const [key, stamps] of rateHits) {
      if (!stamps.length || now - stamps[stamps.length - 1] > RATE_WINDOW_MS) rateHits.delete(key);
    }
  }
  return true;
}

async function readLimited(request) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function publicSendError(error) {
  const msg = String(error?.message || error || '');
  if (/destination|verified|not allowed|recipient/i.test(msg)) {
    return '收件地址还没在 Email Routing 里验证，或绑定的 destination_address 不是这一个 Gmail';
  }
  if (/from|sender|domain/i.test(msg)) {
    return '发件地址必须属于已开通 Email Routing 的域名。请设置 EMAIL_FROM';
  }
  return '邮件没有发出：' + msg.slice(0, 180);
}

export async function handleFavoritesRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405);
  if (!withinRate(clientIp(request))) {
    return json({ ok: false, error: '发送太频繁，请过几分钟再试' }, 429);
  }

  const raw = await readLimited(request);
  if (raw == null) return json({ ok: false, error: '收藏内容太大' }, 413);

  let body;
  try { body = JSON.parse(raw || '{}'); }
  catch { return json({ ok: false, error: 'JSON 无法解析' }, 400); }

  const parsed = validateFavoritesBody(body);
  if (parsed.error) return json({ ok: false, error: parsed.error }, 400);

  const mail = buildFavoritesMail(parsed.items);
  const binding = env && env.EMAIL;
  const canSend = binding && typeof binding.send === 'function';

  if (!canSend) {
    if (!allowDryRun(request, env || {})) {
      console.log(JSON.stringify({ event: 'favorites-mail', ok: false, reason: 'no-binding' }));
      return json({
        ok: false,
        error: 'Email 绑定 EMAIL 还没配上。见 CLOUDFLARE_PAGES.md',
      }, 503);
    }
    console.log(JSON.stringify({ event: 'favorites-mail', ok: true, dryRun: true, items: parsed.items.length }));
    return json({
      ok: true,
      dryRun: true,
      to: RECIPIENT,
      subject: mail.subject,
      markdown: mail.markdown,
      note: '没有 Email 绑定，只生成了 Markdown，没有发信。',
    });
  }

  const from = String(env.EMAIL_FROM || '').trim();
  if (!from) {
    return json({
      ok: false,
      error: '还没有 EMAIL_FROM。请设成你自己 Email Routing 域名上的地址',
    }, 503);
  }

  try {
    const result = await binding.send({
      to: RECIPIENT,
      from,
      subject: mail.subject,
      text: mail.markdown,
      html: mail.html,
      attachments: [{
        content: utf8ToBase64(mail.markdown),
        filename: mail.filename,
        type: 'text/markdown',
        disposition: 'attachment',
      }],
    });
    console.log(JSON.stringify({
      event: 'favorites-mail',
      ok: true,
      dryRun: false,
      items: parsed.items.length,
      messageId: result?.messageId || '',
    }));
    return json({ ok: true, dryRun: false, to: RECIPIENT, subject: mail.subject });
  } catch (error) {
    console.log(JSON.stringify({
      event: 'favorites-mail',
      ok: false,
      code: error?.code || '',
      message: String(error?.message || error).slice(0, 300),
    }));
    return json({ ok: false, error: publicSendError(error) }, 502);
  }
}
