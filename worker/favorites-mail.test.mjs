import assert from 'node:assert/strict';
import test from 'node:test';
import { RECIPIENT, buildFavoritesMail, handleFavoritesRequest, normalizeDoi } from './favorites-mail.js';

const item = {
  title: '一种新的心衰分型',
  titleEn: 'A new heart-failure phenotype',
  journal: 'Lancet',
  abstract: 'Background. We studied 1200 patients.',
  doi: '10.1016/S0140-6736(26)01296-1',
};

function post(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': headers['CF-Connecting-IP'] || ('198.51.100.' + (Math.floor(Math.random() * 200) + 1)),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test('doi normalization', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000/xyz'), '10.1000/xyz');
  assert.equal(normalizeDoi(''), '');
  assert.equal(normalizeDoi('not-a-doi'), null);
  assert.equal(normalizeDoi('https://evil.example/10.1000/x'), null);
});

test('markdown includes title, abstract, and doi url', () => {
  const mail = buildFavoritesMail([item], new Date('2026-10-17T02:00:00Z'));
  assert.equal(mail.subject, 'Radar for Meds 收藏 · 2026-10-17');
  assert.match(mail.markdown, /一种新的心衰分型/);
  assert.match(mail.markdown, /A new heart-failure phenotype/);
  assert.match(mail.markdown, /https:\/\/doi\.org\/10\.1016\/S0140-6736\(26\)01296-1/);
  assert.match(mail.markdown, /We studied 1200 patients/);
  assert.match(mail.markdown, /期刊：Lancet/);
  assert.equal(mail.filename, 'radar-for-meds-favorites-2026-10-17.md');
});

test('localhost without a binding is a dry run', async () => {
  const res = await handleFavoritesRequest(post('http://127.0.0.1/favorites', { items: [item] }), {});
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.dryRun, true);
  assert.equal(data.to, RECIPIENT);
  assert.match(data.markdown, /https:\/\/doi\.org\//);
});

test('public host without a binding does not pretend to send', async () => {
  const res = await handleFavoritesRequest(
    post('https://research-radar-f5j.pages.dev/api/favorites', { items: [item] }),
    {},
  );
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.equal(data.ok, false);
});

test('client cannot choose another recipient', async () => {
  let sent = false;
  const res = await handleFavoritesRequest(
    post('https://research-radar-f5j.pages.dev/api/favorites', {
      to: 'other@example.com',
      items: [item],
    }),
    {
      EMAIL_FROM: 'Radar for Meds <favorites@example.com>',
      EMAIL: { async send() { sent = true; return { messageId: 'nope' }; } },
    },
  );
  assert.equal(res.status, 400);
  assert.equal(sent, false);
});

test('binding sends only to the fixed gmail with a markdown attachment', async () => {
  let message = null;
  const res = await handleFavoritesRequest(
    post('https://research-radar-trigger.robinmarie628.workers.dev/favorites', { items: [item] }),
    {
      EMAIL_FROM: 'Radar for Meds <favorites@example.com>',
      EMAIL: {
        async send(msg) {
          message = msg;
          return { messageId: 'msg-1' };
        },
      },
    },
  );
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.dryRun, false);
  assert.equal(message.to, RECIPIENT);
  assert.equal(message.from, 'Radar for Meds <favorites@example.com>');
  assert.equal(message.subject, 'Radar for Meds 收藏 · ' + data.subject.split(' · ')[1]);
  assert.match(message.text, /# Radar for Meds 收藏/);
  assert.equal(message.attachments.length, 1);
  assert.match(message.attachments[0].filename, /\.md$/);
  assert.equal(message.attachments[0].disposition, 'attachment');
});

test('rejects a bad doi and an oversized list', async () => {
  const bad = await handleFavoritesRequest(
    post('http://127.0.0.1/favorites', { items: [{ title: 'T', doi: 'javascript:alert(1)' }] }),
    {},
  );
  assert.equal(bad.status, 400);
  const many = await handleFavoritesRequest(
    post('http://127.0.0.1/favorites', { items: Array.from({ length: 41 }, (_, i) => ({ title: 'T' + i })) }),
    {},
  );
  assert.equal(many.status, 400);
});

test('rate limit', async () => {
  const ip = '203.0.113.' + Math.floor(Math.random() * 200 + 1);
  let last = 200;
  for (let i = 0; i < 6; i++) {
    const res = await handleFavoritesRequest(
      post('http://127.0.0.1/favorites', { items: [item] }, { 'CF-Connecting-IP': ip }),
      {},
    );
    last = res.status;
  }
  assert.equal(last, 429);
});
