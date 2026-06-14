// とむMYSTIC Service Worker
// 注意: 外部Worker（API）へのクロスオリジン呼び出しは絶対にインターセプトしない。
// 同一オリジンの静的ファイルのみ、ネットワーク優先＋オフライン時キャッシュ。
const CACHE_NAME = 'tomu-mystic-v2';

self.addEventListener('install', e => {
  // 旧SWを待たずに即座に新SWを有効化（古い実装による外部API遮断を解消）
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(['./'])));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // クロスオリジン（外部WorkerへのAPI呼び出し等）はSWを素通りさせる
  if (!e.request.url.startsWith(self.location.origin)) return;
  // GET以外（API POST等が同一オリジンに来た場合も含む）は素通り
  if (e.request.method !== 'GET') return;
  // 同一オリジンGETはネットワーク優先（更新を即反映）、失敗時のみキャッシュ
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
