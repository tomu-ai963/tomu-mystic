// とむMYSTIC Service Worker
// ─────────────────────────────────────────────────────────────────────────
// 構成: フロント = github.io/tomu-mystic/（App Shell） / API = workers.dev（クロスオリジン）
// クロスオリジン構成を前提としたキャッシュ戦略:
//   - App Shell（同一オリジンの HTML/CSS/JS）= Cache First + 裏で更新(Stale-While-Revalidate)
//   - 外部API（クロスオリジン = workers.dev 等）= SWは一切インターセプトしない（常にネットワーク直結）
//       ※過去、外部APIをSWが横取りして "Failed to fetch" / 全アプリ401 を誘発した経緯あり。厳守。
//   - opaque / 非200 レスポンスはキャッシュしない（容量肥大・エラー隠蔽を回避）
// respondWith は常に Response を返し、undefined由来のSWエラーを出さない。
// ─────────────────────────────────────────────────────────────────────────
const CACHE = 'tomu-mystic-v3';

// App Shell の中核（このSWと同階層からの相対パス）。
// 別スコープ(apps/)では一部が404になるため allSettled で取りこぼしを許容。
const SHELL = ['./', './index.html', './mystic.css', './mystic-login.js', './manifest.json'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(SHELL.map(u => c.add(new Request(u, { cache: 'reload' }))))
    )
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// キャッシュ可否: 同一オリジン・200・basic(=非opaque) のみ。opaque/エラーは弾く。
function isCacheable(res) {
  return !!res && res.ok && res.type === 'basic';
}

// ネットワーク取得＋成功時のみ静かにキャッシュ更新
function fetchAndUpdate(req) {
  return fetch(req).then(res => {
    if (isCacheable(res)) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;

  // 1) クロスオリジン（外部API= workers.dev / フォント等）は完全素通り。SWは関与しない。
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  // 2) GET 以外（API POST 等が同一オリジンに来た場合も含む）は素通り。
  if (req.method !== 'GET') return;

  // 3) ナビゲーション（ページ遷移）= Cache First → ネットワーク → オフラインフォールバック
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req).then(hit => {
        const net = fetchAndUpdate(req);
        if (hit) { net.catch(() => {}); return hit; }      // キャッシュ優先＋裏で更新
        return net.catch(async () =>
          (await caches.match('./')) ||
          (await caches.match('./index.html')) ||
          new Response(
            '<!doctype html><meta charset="utf-8"><body style="background:#05050f;color:#e8e0f0;font-family:serif;text-align:center;padding:3rem">オフラインです。電波の良い場所で再度お試しください。</body>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )
        );
      })
    );
    return;
  }

  // 4) App Shell 静的アセット（同一オリジン GET）= Cache First + 裏でSWR更新
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetchAndUpdate(req);
      if (hit) { net.catch(() => {}); return hit; }        // キャッシュ即返し＋裏で静かに更新
      return net;                                          // 未キャッシュはネットワーク（失敗時は通常のネットワークエラー）
    })
  );
});
