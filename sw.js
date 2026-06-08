const CACHE_NAME = 'tomu-mystic-v1';
const urlsToCache = ['./'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache))));
self.addEventListener('fetch', e => {
  // 同一オリジン（GitHub Pages上の静的ファイル）のみキャッシュ対象
  // 外部WorkerへのAPI呼び出しはSWを素通りさせてNetworkタブに正常表示する
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
