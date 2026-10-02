/* 科研雷达 service worker — app shell cached, data always network-first */
const V = 'rr-v7';
const SHELL = [
  './', './index.html', './assets/styles.css', './assets/app.js',
  './data/journals.config.json', './data/glossary.json',
  './manifest.webmanifest', './assets/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // live data + snapshots: network-first, fall back to cache
  const isData = /europepmc|raw\.githubusercontent|snapshot-/.test(url.href)
              || /\/data\//.test(url.pathname);

  if (isData) {
    e.respondWith(
      fetch(req)
        .then(r => {
          const cp = r.clone();
          caches.open(V).then(c => c.put(req, cp)).catch(() => {});
          return r;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // app shell: cache-first
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(r => {
        const cp = r.clone();
        caches.open(V).then(c => c.put(req, cp)).catch(() => {});
        return r;
      }).catch(() => caches.match('./index.html')))
    );
  }
});
