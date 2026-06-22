// ============================================
// とむMYSTIC — Worker.js (Full 30 endpoints)
// ES Module format for Cloudflare Workers
// ============================================

// --------------------------------------------------------------------------
// データストア集約スキーマ（READINGS集約・整理）
// 永続データは D1 を使わず、単一 KV ネームスペース MYSTIC_SUBSCRIPTIONS に
// キープレフィックスで集約している。占い種別の定義は下記 READINGS コード表に
// 一元化され（cf. refactor ab4badc）、占い結果の履歴は history:<userId> 単一
// 構造に集約されている（分散テーブルは存在しない）。
//
//   <userId>                         → サブスクリプション { active, plan, expires, createdAt }
//   session:<sessionId>              → ログインセッション
//   mail_pref:<userId>               → 毎朝メール設定 { enabled, hour, apps }
//   profile:<userId>                 → プロフィール { name, birthdate, ... }
//   history:<userId>                 → 占い結果履歴 [{ action, result, createdAt, extra }]（新しい順・最大30件・TTLなし永続）
//   rate:<type>:<id>:<YYYY-MM-DD-HH> → レートリミットカウンタ（expirationTtl=3600）
//   feed:index / post:<id> / like:<postId>:<userId> → コミュニティ（みんなの占い結果）
//
// 占い種別の正規名（action）は ALLOWED_ACTIONS / READINGS のキーが正、
// 履歴・メール表示名は DAILY_MAIL_APPS 等の表示テーブルが担う。
// --------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-MCP-Token, X-Admin-Token",
};

// ============================================
// 入力バリデーション
// 失敗時は 400 { error: "Invalid input" } を返し、詳細理由は開示しない。
// ============================================

// /api/mystic で受理する action（appId）の許可リスト
const ALLOWED_ACTIONS = new Set([
  "star-reading", "numerology", "guardian-star", "nine-star-ki", "maya-calendar",
  "animal-fortune", "name-fortune", "biorhythm", "moon-sign", "eastern-stars",
  "horoscope-deep", "tarot", "rune-reading", "oracle-cards", "nine-palace",
  "past-life", "past-profession", "soul-mission", "spirit-animal", "aura-reading",
  "chakra-check", "oracle-message", "dream-decoder", "soul-compatibility", "dream-colors",
  "moon-journal", "cosmic-message", "lucky-color", "crystal-guide", "palm-reading",
]);

// action ごとの「必須かつ空文字NGのテキスト項目」
const REQUIRED_TEXT_FIELDS = {
  "animal-fortune": ["animal"],
  "name-fortune": ["fullName"],
  "tarot": ["card"],
  "rune-reading": ["rune"],
  "oracle-cards": ["theme", "card"],
  "oracle-message": ["feeling"],
  "dream-decoder": ["dream"],
  "crystal-guide": ["currentState"],
};

const MAX_TEXT_LEN = 1000;

// 共通バリデーション関数。type に応じて値の妥当性を真偽で返す。
function validateInput(type, value) {
  switch (type) {
    case "birthdate": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [y, m, d] = value.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      // 実在日チェック（例: 2021-02-31 を弾く）
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) return false;
      const t = dt.getTime();
      const min = Date.UTC(1900, 0, 1);
      // 未来日付はNG（今日以前のみ許可）
      return t >= min && t <= Date.now();
    }
    case "email":
      return typeof value === "string"
        && value.length > 0
        && value.length <= 254
        && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "hour":
      return Number.isInteger(value) && value >= 0 && value <= 23;
    case "bool":
      return typeof value === "boolean";
    case "text":
      return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LEN;
    case "appId": // 毎朝メールの占いID
      return typeof value === "string"
        && Object.prototype.hasOwnProperty.call(DAILY_MAIL_APPS, value);
    default:
      return false;
  }
}

// 占いリクエスト（/api/mystic・/mystic/*）のボディ検証
function validateMysticBody(action, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;

  // すべての文字列フィールドは MAX_TEXT_LEN 以内（手相の画像データ imageBase64 は除外）
  for (const [key, v] of Object.entries(body)) {
    if (key === "imageBase64") continue;
    if (typeof v === "string" && v.length > MAX_TEXT_LEN) return false;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.length > MAX_TEXT_LEN) return false;
      }
    }
  }

  // 生年月日（存在する場合のみ・未来日／不正形式NG）
  for (const key of ["birthdate", "birthdate1", "birthdate2"]) {
    if (body[key] !== undefined && !validateInput("birthdate", body[key])) return false;
  }

  // 必須テキスト（空文字NG・1000文字以上NG）
  const requiredText = REQUIRED_TEXT_FIELDS[action];
  if (requiredText) {
    for (const field of requiredText) {
      if (!validateInput("text", body[field])) return false;
    }
  }

  // 夢の色彩：colors は非空の文字列配列
  if (action === "dream-colors") {
    if (!Array.isArray(body.colors) || body.colors.length === 0) return false;
    if (!body.colors.every(c => validateInput("text", c))) return false;
  }

  // 手相：画像データ必須
  if (action === "palm-reading") {
    if (typeof body.imageBase64 !== "string" || body.imageBase64.length === 0) return false;
  }

  return true;
}

// userId（セッションID/メール等の識別子）: 非空・1〜254字・制御文字なし。
// KVキーやStripe metadataに使われるため、改行や制御文字の混入を弾く。
function isValidUserId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 254 && [...v].every(ch => { const c = ch.charCodeAt(0); return c >= 0x20 && c !== 0x7f; });
}

// プラン名: 未指定可。指定時は英数・ハイフン・アンダースコアのみ 1〜32字。
function isValidPlan(v) {
  return v === undefined || (typeof v === "string" && /^[a-z0-9_-]{1,32}$/i.test(v));
}

// リダイレクトURL（Stripe success/cancel）: http(s) かつ許可オリジン or リクエスト自身のオリジンのみ。
// 外部オリジンへの誘導（オープンリダイレクト／XSS）を弾く。
function isAllowedRedirectUrl(raw, selfOrigin) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return ALLOWED_REDIRECT_ORIGINS.includes(u.origin) || u.origin === selfOrigin;
  } catch { return false; }
}

// ============================================
// レートリミット（KVベース）
// キー: rate:{type}:{identifier}:{YYYY-MM-DD-HH}（UTC時）、expirationTtl=3600で自動失効。
// 超過時は false を返す。KVアクセス失敗時は true（可用性優先で通過）。
// MYSTIC_SUBSCRIPTIONS KV を流用。
// ============================================

const RATE_LIMITS = {
  magic: 5,     // /auth/request-magic-link : メアドあたり 5回/時
  ai: 20,       // /api/mystic・/mystic/*    : ユーザーあたり 20回/時
  mailpref: 10, // /mail-pref POST           : ユーザーあたり 10回/時
  history: 60,  // /history/:index DELETE     : ユーザーあたり 60回/時
  profile: 10,  // /profile POST             : ユーザーあたり 10回/時
  communityPost: 10, // /community/post POST  : ユーザーあたり 10回/時
  communityLike: 60, // /community/like POST  : ユーザーあたり 60回/時
  stripe: 10,   // /stripe/checkout          : ユーザーあたり 10回/時（外部Stripe API乱用防止）
};

function rateBucket(date = new Date()) {
  // "2026-06-15T07:23:45.000Z" → "2026-06-15-07"
  return date.toISOString().slice(0, 13).replace("T", "-");
}

async function checkRateLimit(env, type, identifier) {
  const limit = RATE_LIMITS[type];
  if (!limit || !identifier) return true; // 未定義タイプ/識別子なしは制限しない
  const key = `rate:${type}:${identifier}:${rateBucket()}`;
  try {
    const current = parseInt(await env.MYSTIC_SUBSCRIPTIONS.get(key), 10) || 0;
    if (current >= limit) return false;
    await env.MYSTIC_SUBSCRIPTIONS.put(key, String(current + 1), { expirationTtl: 3600 });
    return true;
  } catch {
    return true; // KV障害時は通過（可用性優先）
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      // プリフライト: クライアントが要求したヘッダーをそのまま許可（移行期の旧ヘッダーにも耐性）
      const reqHeaders = request.headers.get("Access-Control-Request-Headers");
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          ...(reqHeaders ? { "Access-Control-Allow-Headers": reqHeaders } : {}),
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return jsonResponse({ status: "とむMYSTIC Worker OK", endpoints: 30 });
    }

    try {
      // ── 認証（マジックリンク + Bearerセッション）
      if (path === "/auth/request-magic-link") return await handleRequestMagicLink(request, env);
      if (path === "/auth/verify")             return await handleVerify(request, env);
      if (path === "/auth/logout")             return await handleLogout(request, env);
      if (path === "/auth/me")                 return await handleMe(request, env);

      if (path.startsWith("/mystic/")) {
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

        const isSubscribed = await checkSubscription(userId, env);
        if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

        // 入力バリデーション（ハンドラ本体はオリジナルのbodyを再読込するためcloneで検証）
        const mysticAction = path.slice("/mystic/".length);
        let mysticBody;
        try { mysticBody = await request.clone().json(); } catch { mysticBody = {}; }
        if (!validateMysticBody(mysticAction, mysticBody)) {
          return jsonResponse({ error: "Invalid input" }, 400);
        }

        // レートリミット（AI呼び出し: ユーザーあたり 20回/時）
        if (!await checkRateLimit(env, "ai", userId)) {
          return jsonResponse({ error: "Too many requests" }, 429);
        }

        return await handleMysticRequest(mysticAction, mysticBody, env, userId);
      }

      if (path === "/api/mystic") {
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

        const isSubscribed = await checkSubscription(userId, env);
        if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

        const body = await request.json();
        const { action, ...rest } = body;
        if (!ALLOWED_ACTIONS.has(action)) return jsonResponse({ error: "Invalid input" }, 400);
        if (!validateMysticBody(action, rest)) return jsonResponse({ error: "Invalid input" }, 400);
        if (!await checkRateLimit(env, "ai", userId)) return jsonResponse({ error: "Too many requests" }, 429);
        return await handleMysticRequest(action, rest, env, userId);
      }

      if (path === "/subscription/check")    return await handleSubscriptionCheck(request, env);
      if (path === "/subscription/register") {
        if (request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) {
          return jsonResponse({ error: "Forbidden" }, 403);
        }
        return await handleSubscriptionRegister(request, env);
      }
      if (path === "/mail-pref")              return await handleMailPref(request, env);
      if (path === "/profile")                return await handleProfile(request, env);
      if (path === "/history" || path.startsWith("/history/")) return await handleHistory(request, env, path);
      if (path.startsWith("/community/")) return await handleCommunity(request, env, path);
      if (path === "/stripe/checkout")       return await handleStripeCheckout(request, env);
      if (path === "/webhook")               return await handleStripeWebhook(request, env);

      if (path === "/mcp")                   return await handleMcp(request, env);

      if (path === "/legal/tokushoho")       return htmlResponse(MYSTIC_TOKUSHOHO_HTML);
      if (path === "/legal/privacy")         return htmlResponse(MYSTIC_PRIVACY_HTML);

      return jsonResponse({ error: "Not Found" }, 404);

    } catch (err) {
      console.error("Unhandled error:", err && (err.stack || err.message));
      return jsonResponse({ error: "占いの取得に失敗しました。時間をおいて再度お試しください。" }, 500);
    }
  },

  // 毎時起動 → 全ユーザーをQueuesにジョブとして積む（配信本体はqueueコンシューマー）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyMail(env));
  },

  // Queueコンシューマー → 1ユーザーずつメール配信を処理
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const { userId, hour, today } = msg.body;
        await processDailyMailUser(userId, hour, today, env);
        msg.ack();
      } catch (err) {
        // 失敗時は自動リトライ（Queuesのデフォルト動作）
        console.error(`Queue処理失敗: ${err && err.message}`);
        msg.retry();
      }
    }
  },
};

// ============================================
// サブスクリプション管理
// ============================================

async function checkSubscription(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(userId);
    if (!data) return false;
    const sub = JSON.parse(data);
    if (sub.expires && new Date(sub.expires) < new Date()) return false;
    return sub.active === true;
  } catch { return false; }
}

async function handleSubscriptionCheck(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  if (!body || typeof body !== "object" || !isValidUserId(body.userId)) {
    return jsonResponse({ error: "Invalid userId" }, 400);
  }
  const isSubscribed = await checkSubscription(body.userId, env);
  return jsonResponse({ subscribed: isSubscribed });
}

async function handleSubscriptionRegister(request, env) {
  let parsed;
  try { parsed = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  if (!parsed || typeof parsed !== "object" || !isValidUserId(parsed.userId)) {
    return jsonResponse({ error: "Invalid userId" }, 400);
  }
  if (!isValidPlan(parsed.plan)) {
    return jsonResponse({ error: "Invalid plan" }, 400);
  }
  const { userId, plan } = parsed;
  const expires = new Date();
  expires.setMonth(expires.getMonth() + 1);
  await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
    active: true,
    plan: plan || "mystic",
    expires: expires.toISOString(),
    createdAt: new Date().toISOString(),
  }));
  return jsonResponse({ success: true });
}

// ============================================
// 認証 — マジックリンク + Bearerセッション
// KVキー: session:<sessionId> → { userId, expiry }
// userId は既存と互換の btoa(email)。サブスク/メール設定のKVキーと一致させる。
// クロスサイト構成（フロント=github.io / API=workers.dev）のため Cookie ではなく
// Authorization: Bearer <sessionId> でセッションを伝送する。
// ============================================

const SESSION_PREFIX = "session:";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;   // 7日
const MAGIC_TOKEN_TTL_SECONDS = 15 * 60;        // 15分
const ALLOWED_REDIRECT_ORIGINS = ["https://tomu-ai963.github.io"];
const DEFAULT_REDIRECT_URL = "https://tomu-ai963.github.io/tomu-mystic/";

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// リダイレクト先を許可originに限定（オープンリダイレクト＋セッション漏洩の防止）
function sanitizeRedirect(raw) {
  try {
    if (!raw) return DEFAULT_REDIRECT_URL;
    const u = new URL(raw);
    if (ALLOWED_REDIRECT_ORIGINS.includes(u.origin)) return u.origin + u.pathname;
  } catch { /* ignore */ }
  return DEFAULT_REDIRECT_URL;
}

// HMAC署名付きマジックトークン（ステートレス、15分有効）
async function createMagicToken(env, email, redirect) {
  const payload = b64urlEncode(JSON.stringify({
    email,
    redirect,
    exp: Math.floor(Date.now() / 1000) + MAGIC_TOKEN_TTL_SECONDS,
  }));
  const sig = await hmacHex(env.AUTH_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifyMagicToken(env, token) {
  if (!token || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmacHex(env.AUTH_SECRET, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  let obj;
  try { obj = JSON.parse(b64urlDecode(payload)); } catch { return null; }
  if (!obj || typeof obj.email !== "string" || !obj.email.includes("@")) return null;
  if (!obj.exp || obj.exp < Math.floor(Date.now() / 1000)) return null;
  return obj;
}

async function createSession(env, userId) {
  const sessionId = crypto.randomUUID();
  const expiry = Date.now() + SESSION_TTL_SECONDS * 1000;
  await env.MYSTIC_SUBSCRIPTIONS.put(
    SESSION_PREFIX + sessionId,
    JSON.stringify({ userId, expiry }),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
  return sessionId;
}

function getBearer(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 全保護ルート共通の認証。成功時は userId（btoa(email)）を返す。
async function authenticate(request, env) {
  const sessionId = getBearer(request);
  if (!sessionId) return null;
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(SESSION_PREFIX + sessionId);
    if (!data) return null;
    const session = JSON.parse(data);
    if (session.expiry && session.expiry < Date.now()) {
      await env.MYSTIC_SUBSCRIPTIONS.delete(SESSION_PREFIX + sessionId);
      return null;
    }
    return session.userId || null;
  } catch {
    return null;
  }
}

// POST /auth/request-magic-link { email, redirect }
async function handleRequestMagicLink(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method Not Allowed" }, 405);
  if (!env.AUTH_SECRET) {
    console.error("AUTH_SECRET が未設定のため認証を実行できません");
    return jsonResponse({ error: "認証が正しく設定されていません" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
  if (!validateInput("email", email)) {
    return jsonResponse({ error: "Invalid input" }, 400);
  }
  // レートリミット（メアドあたり 5回/時）— メール送信前に確認
  if (!await checkRateLimit(env, "magic", email)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  const redirect = sanitizeRedirect(body.redirect);
  const token = await createMagicToken(env, email, redirect);
  const link = `${new URL(request.url).origin}/auth/verify?token=${encodeURIComponent(token)}`;
  await sendMagicLinkEmail(env, email, link);
  return jsonResponse({ success: true });
}

// GET /auth/verify?token=xxx → セッション発行 & フロントへリダイレクト
async function handleVerify(request, env) {
  if (!env.AUTH_SECRET) {
    console.error("AUTH_SECRET が未設定のため認証を実行できません");
    return htmlResponse(authResultPage("認証が正しく設定されていません。", false));
  }
  const token = new URL(request.url).searchParams.get("token");
  const obj = await verifyMagicToken(env, token);
  if (!obj) {
    return htmlResponse(authResultPage("リンクが無効か、有効期限が切れています。お手数ですが、もう一度ログインしてください。", false));
  }
  const userId = btoa(obj.email);            // 既存 identity と互換（KVキー一致）
  const sessionId = await createSession(env, userId);
  const redirect = sanitizeRedirect(obj.redirect);
  const dest = `${redirect}#mystic_sid=${encodeURIComponent(sessionId)}`;
  return new Response(null, { status: 302, headers: { Location: dest, ...CORS_HEADERS } });
}

// POST /auth/logout（Bearer）→ KVからセッション削除
async function handleLogout(request, env) {
  const sessionId = getBearer(request);
  if (sessionId) {
    try { await env.MYSTIC_SUBSCRIPTIONS.delete(SESSION_PREFIX + sessionId); } catch { /* ignore */ }
  }
  return jsonResponse({ success: true });
}

// GET /auth/me（Bearer）→ 現在のログイン状態とサブスク状態
async function handleMe(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);
  const subscribed = await checkSubscription(userId, env);
  let email = null;
  try { email = atob(userId); } catch { /* ignore */ }
  return jsonResponse({ userId, email, subscribed });
}

async function sendMagicLinkEmail(env, to, link) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "とむMYSTIC <noreply@tomu-ai.dev>",
      to: [to],
      subject: "✦ とむMYSTIC ログインリンク",
      html: buildMagicLinkHtml(link),
    }),
  });
  if (!res.ok) {
    console.error(`マジックリンク送信失敗 (${to}): ${await res.text()}`);
    throw new Error("メール送信に失敗しました");
  }
}

function buildMagicLinkHtml(link) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#05050f;font-family:'Hiragino Mincho ProN','Yu Mincho',Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05050f;">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr><td style="padding:0 28px 24px;text-align:center;">
          <p style="margin:0;font-size:13px;letter-spacing:.3em;color:#c49bff;">✦ とむMYSTIC ✦</p>
        </td></tr>
        <tr><td style="padding:0 28px 24px;">
          <div style="background:#11112a;border:1px solid #2a2a4a;border-radius:14px;padding:28px;text-align:center;">
            <p style="margin:0 0 20px;font-size:14px;line-height:1.9;color:#e8e0f0;">下のボタンから、とむMYSTICにログインできます。<br/>このリンクの有効期限は15分です。</p>
            <a href="${link}" style="display:inline-block;background:#c49bff;color:#05050f;text-decoration:none;font-size:14px;letter-spacing:.08em;padding:14px 32px;border-radius:10px;">星の扉を開く</a>
            <p style="margin:20px 0 0;font-size:11px;line-height:1.8;color:#8880a8;">このメールに心当たりがない場合は、破棄してください。</p>
          </div>
        </td></tr>
        <tr><td style="padding:4px 28px 0;text-align:center;">
          <p style="margin:0;font-size:10px;letter-spacing:.15em;color:#8880a8;">© 2026 とむMYSTIC</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function authResultPage(message, ok) {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>とむMYSTIC</title></head>
<body style="margin:0;background:#05050f;color:#e8e0f0;font-family:'Hiragino Mincho ProN','Yu Mincho',Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center;">
  <div style="max-width:420px;padding:2rem;text-align:center;">
    <p style="font-size:13px;letter-spacing:.3em;color:#c49bff;margin:0 0 1.5rem;">✦ とむMYSTIC ✦</p>
    <p style="font-size:14px;line-height:1.9;color:${ok ? "#e8e0f0" : "#ffb3b3"};">${escapeHtml(message)}</p>
    <p style="margin-top:2rem;"><a href="${DEFAULT_REDIRECT_URL}" style="color:#c49bff;font-size:13px;">トップへ戻る</a></p>
  </div>
</body></html>`;
}

// ============================================
// 毎朝の占いメール — 配信設定管理
// KVキー: mail_pref:<userId> → { enabled, apps, hour }
// ============================================

const MAIL_PREF_PREFIX = "mail_pref:";
const DEFAULT_MAIL_PREF = { enabled: false, apps: [], hour: 7 };

async function getMailPref(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(MAIL_PREF_PREFIX + userId);
    if (!data) return { ...DEFAULT_MAIL_PREF };
    const pref = JSON.parse(data);
    return {
      enabled: pref.enabled === true,
      apps: Array.isArray(pref.apps) ? pref.apps : [],
      hour: Number.isInteger(pref.hour) ? pref.hour : DEFAULT_MAIL_PREF.hour,
    };
  } catch {
    return { ...DEFAULT_MAIL_PREF };
  }
}

async function handleMailPref(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  if (request.method === "GET") {
    return jsonResponse({ pref: await getMailPref(userId, env) });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    // バリデーション: enabled=boolean / hour=0〜23整数 / apps=許可IDの配列
    if (!validateInput("bool", body.enabled)) return jsonResponse({ error: "Invalid input" }, 400);
    if (!validateInput("hour", body.hour)) return jsonResponse({ error: "Invalid input" }, 400);
    if (!Array.isArray(body.apps) || !body.apps.every(id => validateInput("appId", id))) {
      return jsonResponse({ error: "Invalid input" }, 400);
    }
    // レートリミット（ユーザーあたり 10回/時）
    if (!await checkRateLimit(env, "mailpref", userId)) {
      return jsonResponse({ error: "Too many requests" }, 429);
    }
    const pref = { enabled: body.enabled, apps: body.apps, hour: body.hour };
    await env.MYSTIC_SUBSCRIPTIONS.put(MAIL_PREF_PREFIX + userId, JSON.stringify(pref));
    return jsonResponse({ success: true, pref });
  }

  return jsonResponse({ error: "Method Not Allowed" }, 405);
}

// ============================================
// 占い履歴
// KVキー: history:<userId> → 直近 HISTORY_MAX 件の配列（新しい順）
// 各要素: { action, result, createdAt, extra }
// 永続保存（expirationTtl なし）。MYSTIC_SUBSCRIPTIONS KV を流用。
// ============================================

const HISTORY_PREFIX = "history:";
const HISTORY_MAX = 30;

async function getHistory(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(HISTORY_PREFIX + userId);
    if (!data) return [];
    const list = JSON.parse(data);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// 占い結果を履歴へ追加（新しい順）。HISTORY_MAX 超過分は古いものから破棄。
// 保存失敗は占い結果の返却を妨げない（ベストエフォート）。
async function saveHistory(env, userId, entry) {
  try {
    const list = await getHistory(userId, env);
    list.unshift(entry);
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    await env.MYSTIC_SUBSCRIPTIONS.put(HISTORY_PREFIX + userId, JSON.stringify(list));
  } catch (err) {
    console.error(`履歴保存失敗 (${userId}): ${err && err.message}`);
  }
}

// GET /history          → 履歴一覧
// DELETE /history/:index → index 番目（新しい順・0始まり）を1件削除
async function handleHistory(request, env, path) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  if (path === "/history") {
    if (request.method !== "GET") return jsonResponse({ error: "Method Not Allowed" }, 405);
    return jsonResponse({ history: await getHistory(userId, env) });
  }

  // /history/:index
  if (request.method !== "DELETE") return jsonResponse({ error: "Method Not Allowed" }, 405);

  const index = Number(path.slice("/history/".length));
  if (!Number.isInteger(index) || index < 0) return jsonResponse({ error: "Invalid input" }, 400);

  // レートリミット（ユーザーあたり 60回/時）
  if (!await checkRateLimit(env, "history", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }

  const list = await getHistory(userId, env);
  if (index >= list.length) return jsonResponse({ error: "Not Found" }, 404);
  list.splice(index, 1);
  try {
    await env.MYSTIC_SUBSCRIPTIONS.put(HISTORY_PREFIX + userId, JSON.stringify(list));
  } catch (err) {
    console.error(`履歴削除失敗 (${userId}): ${err && err.message}`);
    return jsonResponse({ error: "削除に失敗しました" }, 500);
  }
  return jsonResponse({ success: true, history: list });
}

// ============================================
// コミュニティ（みんなの占い結果）
// OriacleのSNS機能を移植。認証=既存Bearerセッション / サブスク必須。
// KV（MYSTIC_SUBSCRIPTIONS を流用）:
//   feed:index             → 投稿IDの配列（新しい順・最大 COMMUNITY_FEED_MAX 件）
//   post:<id>              → 投稿オブジェクト（TTL 90日）
//   like:<postId>:<userId> → いいね済みフラグ（TTL 90日・重複防止）
// 投稿IDは ULID（時系列ソート可能）。
// ============================================

const COMMUNITY_FEED_MAX = 100;
const COMMUNITY_POST_TTL = 90 * 24 * 60 * 60; // 90日
const COMMUNITY_APPNAME_MAX = 100;
const COMMUNITY_COMMENT_MAX = 200;

// Crockford base32（ULID用）
const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// 先頭10文字=50bitタイムスタンプ＋後16文字=80bitランダム
function generateULID() {
  let id = "";
  let t = Date.now();
  for (let i = 9; i >= 0; i--) {
    id = ULID_CHARS[t % 32] + id;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) {
    id += ULID_CHARS[Math.floor(Math.random() * 32)];
  }
  return id;
}

// 表示名（プロフィール登録名 → 無ければ匿名）。メールアドレスは公開しない。
function communityDisplayName(profile) {
  const name = (profile && typeof profile.name === "string") ? profile.name.trim() : "";
  return name || "匿名の旅人";
}

// /community/* 共通処理（認証＋サブスク必須）
async function handleCommunity(request, env, path) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  const isSubscribed = await checkSubscription(userId, env);
  if (!isSubscribed) return jsonResponse({ error: "サブスクリプションが必要です" }, 403);

  const method = request.method;
  if (path === "/community/feed" && method === "GET")  return await handleCommunityFeed(env);
  if (path === "/community/post" && method === "POST") return await handleCommunityPost(request, env, userId);
  if (path === "/community/like" && method === "POST") return await handleCommunityLike(request, env, userId);
  if (path.startsWith("/community/post/") && method === "DELETE") {
    return await handleCommunityDelete(env, userId, path.slice("/community/post/".length));
  }
  return jsonResponse({ error: "Not Found" }, 404);
}

// GET /community/feed → 投稿一覧（新しい順）
async function handleCommunityFeed(env) {
  const feedRaw = await env.MYSTIC_SUBSCRIPTIONS.get("feed:index");
  if (!feedRaw) return jsonResponse({ posts: [] });
  let ids;
  try { ids = JSON.parse(feedRaw); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  const posts = await Promise.all(ids.map(async (id) => {
    const raw = await env.MYSTIC_SUBSCRIPTIONS.get(`post:${id}`);
    return raw ? JSON.parse(raw) : null;
  }));
  return jsonResponse({ posts: posts.filter(Boolean) });
}

// POST /community/post → 投稿作成
async function handleCommunityPost(request, env, userId) {
  if (!await checkRateLimit(env, "communityPost", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResponse({ error: "Invalid input" }, 400);

  const appName = typeof body.appName === "string" ? body.appName.trim() : "";
  const resultText = typeof body.resultText === "string" ? body.resultText.trim() : "";
  const userComment = typeof body.userComment === "string" ? body.userComment.trim() : "";

  // appName: 非空・100文字以内 / resultText: 1〜1000文字（text検証を流用）/ userComment: 200文字以内
  if (!appName || appName.length > COMMUNITY_APPNAME_MAX) return jsonResponse({ error: "Invalid input" }, 400);
  if (!validateInput("text", resultText)) return jsonResponse({ error: "Invalid input" }, 400);
  if (userComment.length > COMMUNITY_COMMENT_MAX) return jsonResponse({ error: "Invalid input" }, 400);

  const profile = await getProfile(userId, env);
  const id = generateULID();
  const post = {
    id,
    userId,
    username: communityDisplayName(profile),
    appName,
    resultText,
    userComment,
    createdAt: new Date().toISOString(),
    likes: 0,
  };

  let feed;
  const feedRaw = await env.MYSTIC_SUBSCRIPTIONS.get("feed:index");
  try { feed = feedRaw ? JSON.parse(feedRaw) : []; } catch { feed = []; }
  if (!Array.isArray(feed)) feed = [];
  feed.unshift(id);
  if (feed.length > COMMUNITY_FEED_MAX) feed.length = COMMUNITY_FEED_MAX;

  await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.put(`post:${id}`, JSON.stringify(post), { expirationTtl: COMMUNITY_POST_TTL }),
    env.MYSTIC_SUBSCRIPTIONS.put("feed:index", JSON.stringify(feed)),
  ]);

  return jsonResponse({ post }, 201);
}

// POST /community/like → いいね（重複不可）
async function handleCommunityLike(request, env, userId) {
  if (!await checkRateLimit(env, "communityLike", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  const postId = (body && typeof body.postId === "string") ? body.postId : "";
  if (!postId) return jsonResponse({ error: "Invalid input" }, 400);

  const likeKey = `like:${postId}:${userId}`;
  const [alreadyLiked, postRaw] = await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.get(likeKey),
    env.MYSTIC_SUBSCRIPTIONS.get(`post:${postId}`),
  ]);
  if (alreadyLiked) return jsonResponse({ error: "すでにいいね済みです" }, 409);
  if (!postRaw) return jsonResponse({ error: "Not Found" }, 404);

  const post = JSON.parse(postRaw);
  post.likes = (post.likes || 0) + 1;

  await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.put(`post:${postId}`, JSON.stringify(post), { expirationTtl: COMMUNITY_POST_TTL }),
    env.MYSTIC_SUBSCRIPTIONS.put(likeKey, "1", { expirationTtl: COMMUNITY_POST_TTL }),
  ]);

  return jsonResponse({ likes: post.likes });
}

// DELETE /community/post/:id → 自分の投稿のみ削除
async function handleCommunityDelete(env, userId, id) {
  if (!id) return jsonResponse({ error: "Invalid input" }, 400);
  const raw = await env.MYSTIC_SUBSCRIPTIONS.get(`post:${id}`);
  if (!raw) return jsonResponse({ error: "Not Found" }, 404);
  const post = JSON.parse(raw);
  if (post.userId !== userId) return jsonResponse({ error: "Forbidden" }, 403);

  let feed = [];
  const feedRaw = await env.MYSTIC_SUBSCRIPTIONS.get("feed:index");
  try { feed = feedRaw ? JSON.parse(feedRaw) : []; } catch { feed = []; }
  feed = Array.isArray(feed) ? feed.filter((x) => x !== id) : [];

  await Promise.all([
    env.MYSTIC_SUBSCRIPTIONS.delete(`post:${id}`),
    env.MYSTIC_SUBSCRIPTIONS.put("feed:index", JSON.stringify(feed)),
  ]);

  return jsonResponse({ success: true });
}

// ============================================
// Stripe Checkout セッション作成
// ============================================

async function handleStripeCheckout(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);
  // レートリミット（外部Stripe API呼び出し: ユーザーあたり 10回/時）
  if (!await checkRateLimit(env, "stripe", userId)) {
    return jsonResponse({ error: "Too many requests" }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "Invalid input" }, 400); }
  const { successUrl, cancelUrl } = body || {};
  // success/cancel は外部リダイレクト先。許可オリジン以外はオープンリダイレクト/XSS防止のため弾く。
  const selfOrigin = new URL(request.url).origin;
  if (!isAllowedRedirectUrl(successUrl, selfOrigin) || !isAllowedRedirectUrl(cancelUrl, selfOrigin)) {
    return jsonResponse({ error: "Invalid redirect URL" }, 400);
  }

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "payment_method_types[]": "card",
      "mode": "subscription",
      "line_items[0][price]": env.MYSTIC_PRICE_ID,
      "line_items[0][quantity]": "1",
      "metadata[userId]": userId,
      "success_url": successUrl,
      "cancel_url": cancelUrl,
    }),
  });

  const session = await res.json();
  if (!res.ok) return jsonResponse({ error: session.error?.message || "Stripe エラー" }, 500);
  return jsonResponse({ url: session.url });
}

// ============================================
// Stripe Webhook 受信・サブスク有効化
// ============================================

async function handleStripeWebhook(request, env) {
  const signature = request.headers.get("stripe-signature");
  const body = await request.text();

  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET が未設定のため Webhook を拒否しました");
    return jsonResponse({ error: "Webhook が正しく設定されていません" }, 500);
  }
  const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return jsonResponse({ error: "署名が無効です" }, 400);

  const event = JSON.parse(body);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      await env.MYSTIC_SUBSCRIPTIONS.put(userId, JSON.stringify({
        active: true,
        plan: "mystic",
        stripeCustomerId: session.customer,
        stripeSubscriptionId: session.subscription,
        expires: expires.toISOString(),
        createdAt: new Date().toISOString(),
      }));
    }
  }

  return jsonResponse({ received: true });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k.trim()] = v;
      return acc;
    }, {});

    const signedPayload = `${parts.t}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computed === parts.v1;
  } catch {
    return false;
  }
}

// ============================================
// Claude API 呼び出し共通関数
// ============================================

const ABSOLUTE_RULE = `\n\n【絶対ルール】ユーザーメッセージ内の数値・星座名・画数・干支などの確定済みデータは、あなたの知識と異なっていても絶対に変更しないでください。それらはシステムが正確に計算した値です。`;

async function callClaude(env, systemPrompt, userMessage, maxTokens = 800) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt + ABSOLUTE_RULE,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  return data.content[0].text;
}

async function callClaudeVision(env, systemPrompt, imageBase64, mimeType = "image/jpeg", maxTokens = 800) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      system: systemPrompt + ABSOLUTE_RULE,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: "この手のひらの手相を占ってください。" },
        ],
      }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  return data.content[0].text;
}

// ============================================
// 確定計算ユーティリティ
// ============================================

function getSunSign(birthdate) {
  const [, m, d] = birthdate.split('-').map(Number);
  if ((m===3&&d>=21)||(m===4&&d<=19)) return '牡羊座';
  if ((m===4&&d>=20)||(m===5&&d<=20)) return '牡牛座';
  if ((m===5&&d>=21)||(m===6&&d<=21)) return '双子座';
  if ((m===6&&d>=22)||(m===7&&d<=22)) return '蟹座';
  if ((m===7&&d>=23)||(m===8&&d<=22)) return '獅子座';
  if ((m===8&&d>=23)||(m===9&&d<=22)) return '乙女座';
  if ((m===9&&d>=23)||(m===10&&d<=23)) return '天秤座';
  if ((m===10&&d>=24)||(m===11&&d<=22)) return '蠍座';
  if ((m===11&&d>=23)||(m===12&&d<=21)) return '射手座';
  if ((m===12&&d>=22)||(m===1&&d<=19)) return '山羊座';
  if ((m===1&&d>=20)||(m===2&&d<=18)) return '水瓶座';
  return '魚座';
}

function getNineStarKi(birthdate) {
  const [y, m, d] = birthdate.split('-').map(Number);
  const ay = (m===1||(m===2&&d<=3)) ? y-1 : y;
  let s = String(ay).split('').reduce((a,b)=>a+parseInt(b),0);
  while(s>=10) s=String(s).split('').reduce((a,b)=>a+parseInt(b),0);
  const n = (11-s)%9||9;
  const names=['','一白水星','二黒土星','三碧木星','四緑木星','五黄土星','六白金星','七赤金星','八白土星','九紫火星'];
  return {num:n, name:names[n]};
}

function getMayaKin(birthdate) {
  const base = Date.UTC(2000,0,1);
  const [y,m,d] = birthdate.split('-').map(Number);
  const diff = Math.round((Date.UTC(y,m-1,d)-base)/86400000);
  const kin = ((143+diff)%260+260)%260+1;
  const tones=['磁気','月','電気','自己存在','倍音','リズム','共鳴','銀河','太陽','惑星','スペクトル','水晶','宇宙'];
  const seals=['赤い龍','白い風','青い夜','黄色い種','赤い蛇','白い世界の橋渡し','青い手','黄色い星','赤い月','白い犬','青い猿','黄色い人','赤い空歩く者','白い魔法使い','青い鷲','黄色い戦士','赤い地球','白い鏡','青い嵐','黄色い太陽'];
  return {kin, tone:tones[(kin-1)%13], seal:seals[(kin-1)%20]};
}

function getLifePathNumber(birthdate) {
  let n = birthdate.replace(/-/g,'').split('').reduce((a,b)=>a+parseInt(b),0);
  while(n>9&&n!==11&&n!==22&&n!==33) n=String(n).split('').reduce((a,b)=>a+parseInt(b),0);
  return n;
}

function getEto(birthdate) {
  const y = parseInt(birthdate.split('-')[0]);
  const junishi=['申','酉','戌','亥','子','丑','寅','卯','辰','巳','午','未'];
  const jikkan=['庚','辛','壬','癸','甲','乙','丙','丁','戊','己'];
  return {kan:jikkan[y%10], eto:junishi[y%12]};
}

// 人名用漢字画数テーブル
const KS = {
  '一':1,
  '乃':2,'七':2,'二':2,'人':2,'入':2,'八':2,'力':2,'十':2,'刀':2,'丁':2,
  '三':3,'口':3,'土':3,'大':3,'女':3,'子':3,'小':3,'山':3,'川':3,'千':3,'久':3,'丈':3,'万':3,'干':3,'也':3,'己':3,'士':3,'弓':3,'上':3,'下':3,
  '中':4,'今':4,'仁':4,'元':4,'内':4,'公':4,'六':4,'天':4,'太':4,'五':4,'心':4,'手':4,'文':4,'方':4,'木':4,'月':4,'水':4,'火':4,'王':4,'日':4,'円':4,'少':4,'友':4,'反':4,'化':4,'比':4,'夫':4,'支':4,'斗':4,'不':4,'丹':4,
  '四':5,'以':5,'加':5,'史':5,'司':5,'右':5,'古':5,'由':5,'央':5,'功':5,'令':5,'冬':5,'出':5,'半':5,'占':5,'外':5,'広':5,'弘':5,'末':5,'本':5,'永':5,'玄':5,'玉':5,'平':5,'礼':5,'世':5,'正':5,'生':5,'白':5,'石':5,'田':5,'目':5,'北':5,'申':5,'甲':5,'矢':5,'台':5,'布':5,'市':5,'付':5,'仙':5,
  '伊':6,'光':6,'全':6,'共':6,'合':6,'向':6,'在':6,'多':6,'宇':6,'安':6,'守':6,'宏':6,'次':6,'気':6,'江':6,'成':6,'早':6,'旭':6,'朱':6,'西':6,'羽':6,'老':6,'自':6,'至':6,'舟':6,'血':6,'衣':6,'行':6,'先':6,'名':6,'年':6,'有':6,'百':6,'竹':6,'色':6,'地':6,'帆':6,'凪':6,'吉':6,'好':6,'再':6,'兆':6,'汐':6,'仲':6,'任':6,'伏':6,'朴':6,'曲':6,'妃':6,
  '亜':7,'位':7,'住':7,'克':7,'初':7,'別':7,'努':7,'労':7,'吾':7,'告':7,'君':7,'孝':7,'完':7,'志':7,'忘':7,'我':7,'改':7,'束':7,'杏':7,'李':7,'材':7,'沙':7,'那':7,'均':7,'岐':7,'妙':7,'良':7,'花':7,'赤':7,'男':7,'村':7,'里':7,'来':7,'言':7,'見':7,'車':7,'何':7,'冴':7,'佐':7,'希':7,'抄':7,'沖':7,'扶':7,'佑':7,'宋':7,'肖':7,'寿':7,'汰':7,'伸':7,'伶':7,
  '佳':8,'依':8,'典':8,'具':8,'制':8,'到':8,'命':8,'固':8,'奈':8,'委':8,'定':8,'宗':8,'官':8,'宙':8,'宝':8,'尚':8,'岩':8,'岸':8,'幸':8,'拓':8,'松':8,'武':8,'治':8,'法':8,'沼':8,'炎':8,'物':8,'直':8,'知':8,'空':8,'育':8,'英':8,'茉':8,'長':8,'門':8,'昌':8,'旺':8,'実':8,'昂':8,'林':8,'金':8,'青':8,'学':8,'岡':8,'和':8,'周':8,'承':8,'征':8,'怜':8,'侑':8,'坪':8,'果':8,'昇':8,'宜':8,'虎':8,'並':8,'卓':8,'奉':8,'享':8,'茂':8,'阿':8,'昆':8,'昔':8,'仰':8,
  '哉':9,'型':9,'城':9,'威':9,'奏':9,'姿':9,'室':9,'宣':9,'帝':9,'建':9,'持':9,'政':9,'故':9,'柄':9,'柔':9,'柳':9,'洋':9,'洲':9,'活':9,'津':9,'研':9,'秋':9,'紀':9,'美':9,'背':9,'胡':9,'茜':9,'音':9,'飛':9,'哀':9,'勇':9,'厚':9,'咲':9,'香':9,'春':9,'海':9,'南':9,'星':9,'風':9,'保':9,'信':9,'前':9,'昴':9,'俊':9,'宥':9,'亮':9,'玲':9,'珂':9,'拳':9,'点':9,'律':9,'皇':9,'玻':9,'珊':9,'郎':9,
  '原':10,'家':10,'真':10,'桜':10,'純':10,'留':10,'修':10,'倫':10,'哲':10,'容':10,'宮':10,'展':10,'恋':10,'悟':10,'振':10,'根':10,'格':10,'桂':10,'桃':10,'流':10,'浩':10,'浪':10,'浦':10,'特':10,'益':10,'神':10,'秦':10,'紘':10,'紗':10,'素':10,'能':10,'透':10,'泰':10,'泳':10,'夏':10,'晃':10,'洸':10,'竜':10,'将':10,'航':10,'凌':10,'隼':10,'朔':10,'梅':10,'捷':10,'倖':10,'恭':10,'時':10,'朗':10,
  '健':11,'唯':11,'凰':11,'啓':11,'問':11,'基':11,'堂':11,'堅':11,'悠':11,'梨':11,'梓':11,'清':11,'渉':11,'渓':11,'淳':11,'深':11,'理':11,'現':11,'紬':11,'脩':11,'彩':11,'黄':11,'鹿':11,'崇':11,'康':11,'陸':11,'麻':11,'渚':11,'野':11,'球':11,'帯':11,'副':11,'務':11,'動':11,'匡':11,'猛':11,'崚':11,'鳥':11,'彬':11,'惇':11,
  '朝':12,'博':12,'善':12,'尊':12,'幾':12,'敦':12,'最':12,'植':12,'湯':12,'無':12,'登':12,'絢':12,'絵':12,'結':12,'翔':12,'雄':12,'森':12,'湖':12,'満':12,'晴':12,'喜':12,'御':12,'勝':12,'葵':12,'琴':12,'稀':12,'葉':12,'椎':12,'陽':12,'裕':12,'智':12,'創':12,'統':12,'景':12,'晶':12,'達':12,'運':12,'策':12,'琢':11,
  '蒼':13,'遥':13,'蓮':13,'愛':13,'義':13,'想':13,'新':13,'業':13,'極':13,'楓':13,'歳':13,'滋':13,'照':13,'詩':13,'路':13,'聖':13,'頌':13,'暖':13,'椿':13,'楠':13,'豊':13,'誠':13,'源':13,'瑛':13,
  '静':14,'緑':14,'歌':14,'維':14,'徳':14,'漢':14,'端':14,'翠':14,'語':14,'誓':14,'銀':14,'関':14,'嘉':14,'聡':14,'彰':14,'豪':14,'颯':14,'碧':14,
  '輝':15,'熱':15,'確':15,'論':15,'穂':15,'璃':15,'凛':15,'凜':15,
  '樹':16,'橋':16,'整':16,'親':16,'頼':16,'龍':16,'賢':16,
  '謙':17,'霞':17,'鎌':18,'蘭':19,'鶴':21,'麟':23,
};

function calcGoKaku(fullName) {
  const trimmed = fullName.trim();
  const spIdx = trimmed.search(/[\s　]/);
  let sei, mei;
  if (spIdx > 0) {
    sei = trimmed.slice(0, spIdx).split('');
    mei = trimmed.slice(spIdx+1).trim().split('');
  } else {
    const half = Math.ceil(trimmed.length/2);
    sei = trimmed.slice(0, half).split('');
    mei = trimmed.slice(half).split('');
  }
  const strokes = c => KS[c] ?? '?';
  const ss = sei.map(strokes);
  const ms = mei.map(strokes);
  const ok = arr => arr.every(v=>v!=='?');
  const sum = arr => arr.reduce((a,b)=>a+(b==='?'?0:b),0);
  const tenkaku = ok(ss) ? sum(ss) : '?';
  const chikaku = ok(ms) ? sum(ms) : '?';
  const jinkaku = (ss[ss.length-1]!=='?' && ms[0]!=='?') ? ss[ss.length-1]+ms[0] : '?';
  const soukaku = (tenkaku!=='?' && chikaku!=='?') ? tenkaku+chikaku : '?';
  const sotokaku = (soukaku!=='?' && jinkaku!=='?') ? soukaku-jinkaku : '?';
  return {
    sei: sei.join(''), mei: mei.join(''),
    seiStrokes: ss, meiStrokes: ms,
    tenkaku, jinkaku, chikaku, sotokaku, soukaku,
    unknown: [...ss,...ms].some(v=>v==='?'),
  };
}

// ============================================
// 占い種別テーブル（READINGS）
// 30種の占いを「データ」として一元管理する。各エントリ:
//   system : 既定のシステムプロンプト
//   vision : true なら画像（Vision API）を使う占い
//   build(body) : 入力 body から以下のいずれかを返す
//     { user, extra }                  … 通常占い（user=ユーザーメッセージ / extra=追加レスポンス項目）
//     { system, user, extra }          … システムプロンプトを動的生成する占い（system が優先）
//     { imageBase64, mimeType, extra } … vision の占い
// ※ プロンプト内容・レスポンス形状は従来の個別ハンドラと完全一致させること。
// ============================================
const READINGS = {
  // ① 今日の星読み
  "star-reading": {
    system: `あなたは神秘的な星読み師です。以下の確定済みデータを元に、今日の星の配置に基づいたメッセージを詩的で神秘的な文体で日本語で届けてください。星座の判定は変えないでください。200〜300文字程度で。`,
    build(body) {
      const sign = getSunSign(body.birthdate);
      return { user: `生年月日：${body.birthdate}\n太陽星座：${sign}`, extra: { sign } };
    },
  },

  // ② 数秘術診断
  "numerology": {
    system: `あなたは数秘術の達人です。以下の確定済みライフパスナンバーを元に、魂の使命と今世のテーマを神秘的な文体で日本語で伝えてください。ライフパスナンバーの数値は変えないでください。300文字程度で。`,
    build(body) {
      const lpn = getLifePathNumber(body.birthdate);
      return { user: `名前：${body.name}\n生年月日：${body.birthdate}\nライフパスナンバー：${lpn}`, extra: { lifePathNumber: lpn } };
    },
  },

  // ③ 守護星特定
  "guardian-star": {
    system: `あなたは星の守護者です。以下の確定済みデータを元に、守護星の性質と今週の指針・開運アドバイスを神秘的な文体で日本語で届けてください。星座は変えないでください。300文字程度で。`,
    build(body) {
      const sign = getSunSign(body.birthdate);
      return { user: `生年月日：${body.birthdate}\n太陽星座：${sign}`, extra: { sign } };
    },
  },

  // ④ 九星気学診断
  "nine-star-ki": {
    system: `あなたは九星気学の達人です。以下の確定済みデータを元に、その人の本質・人生テーマ・今年の運気を神秘的な文体で日本語で伝えてください。本命星の名前と番号は変えないでください。350文字程度で。`,
    build(body) {
      const ki = getNineStarKi(body.birthdate);
      return { user: `生年月日：${body.birthdate}\n本命星：${ki.name}（${ki.num}）`, extra: { honmeisei: ki.name, honmeiseiNum: ki.num } };
    },
  },

  // ⑤ マヤ暦診断
  "maya-calendar": {
    system: `ユーザーのKIN番号・太陽の紋章・ウェーブスペル・音はすでに正確に計算済みです。
あなたが再計算する必要は一切ありません。
必ず渡された値（KIN・紋章・ウェーブスペル・音）をそのまま使ってメッセージを作成してください。
絶対に別のKIN番号や紋章を提示しないでください。

あなたはマヤ暦の占い師です。以下の確定済みデータを元に、その魂のエネルギー・使命・才能を神秘的な文体で日本語で伝えてください。350文字程度で。`,
    build(body) {
      const { birthdate, kin, tone, toneNumber, seal, wavespell, wavespellSeal } = body;
      return {
        user: `生年月日：${birthdate}\nKIN番号：${kin}\n音（トーン）：${tone}（${toneNumber}）\n太陽の紋章：${seal}\nウェーブスペル：${wavespellSeal}のウェーブスペル（第${wavespell}ウェーブスペル）`,
        extra: { kin, tone, toneNumber, seal, wavespell, wavespellSeal },
      };
    },
  },

  // ⑥ 動物占い（システムプロンプトを動的生成）
  "animal-fortune": {
    build(body) {
      const { birthdate, animal } = body;
      return {
        system: `あなたは動物キャラナビの占い師です。「${animal}」タイプの人の性格・運勢・対人関係をスピリチュアルな観点で200字程度で鑑定してください。`,
        user: `生年月日：${birthdate}、守護動物：${animal}`,
        extra: { animal },
      };
    },
  },

  // ⑦ 姓名判断
  "name-fortune": {
    system: `あなたは姓名判断の達人です。以下の画数は確定値です。この数値を使って運命の流れと今後の指針を神秘的な文体で日本語で伝えてください。絶対に画数を再計算しないでください。400文字程度で。`,
    build(body) {
      const { fullName, tenkaku: clientTk, jinkaku: clientJk, chikaku: clientCk, sotokaku: clientGk, soukaku: clientSk, confirmedGoKaku } = body;

      // クライアントから確定値が送られている場合はそれを優先（再計算しない）
      let tk, jk, ck, gk, sk, unknownNote;
      if (confirmedGoKaku && clientTk !== undefined) {
        tk = clientTk; jk = clientJk; ck = clientCk; gk = clientGk; sk = clientSk;
        unknownNote = (tk === '?' || jk === '?' || ck === '?' || gk === '?' || sk === '?')
          ? '\n※一部の漢字の画数が未登録のため「?」としています。' : '';
      } else {
        const calc = calcGoKaku(fullName);
        tk = calc.tenkaku; jk = calc.jinkaku; ck = calc.chikaku; gk = calc.sotokaku; sk = calc.soukaku;
        unknownNote = calc.unknown ? '\n※一部の漢字の画数が未登録のため「?」としています。' : '';
      }

      return {
        user: `氏名：${fullName}
【確定済み五格 — 絶対に再計算しないでください】
天格：${tk}（確定値）
人格：${jk}（確定値）
地格：${ck}（確定値）
外格：${gk}（確定値）
総格：${sk}（確定値）${unknownNote}
以上の数値をそのまま使い、独自に画数を算出・修正しないでください。`,
        extra: { goKaku: { tenkaku: tk, jinkaku: jk, chikaku: ck, sotokaku: gk, soukaku: sk } },
      };
    },
  },

  // ⑧ バイオリズム
  "biorhythm": {
    system: `あなたはバイオリズムを読む占い師です。指定日における肉体・感情・知性の3つのリズム値を受け取り、その人の今日のコンディションと取るべき行動指針を神秘的な文体で日本語で伝えてください。300文字程度で。`,
    build(body) {
      const { targetDate, physical, emotional, intellectual } = body;
      return { user: `対象日：${targetDate}、肉体リズム：${physical}%、感情リズム：${emotional}%、知性リズム：${intellectual}%` };
    },
  },

  // ⑨ ムーンサイン診断
  "moon-sign": {
    system: `あなたは月星座の占い師です。以下の確定済みデータを元に、その人の内面・感情パターン・本当の欲求を神秘的な文体で日本語で伝えてください。太陽星座・月星座・ライフパスナンバーは変えないでください。300文字程度で。`,
    build(body) {
      const { birthdate, zodiacSign, lifePathNumber, moonSign } = body;
      const sign = zodiacSign || getSunSign(birthdate);
      const lpn = lifePathNumber || getLifePathNumber(birthdate);
      return {
        user: `生年月日：${birthdate}\n太陽星座：${sign}\n月星座：${moonSign}\nライフパスナンバー：${lpn}`,
        extra: { sunSign: sign, moonSign, lifePathNumber: lpn },
      };
    },
  },

  // ⑩ 東洋星座×干支診断
  "eastern-stars": {
    system: `あなたは東洋占星術の達人です。以下の確定済みデータを元に、その人の宿命・才能・今年の運勢を神秘的な文体で日本語で伝えてください。干支・本命星は変えないでください。350文字程度で。`,
    build(body) {
      const eto = getEto(body.birthdate);
      const ki = getNineStarKi(body.birthdate);
      return {
        user: `生年月日：${body.birthdate}\n干支：${eto.kan}${eto.eto}\n本命星：${ki.name}`,
        extra: { eto: `${eto.kan}${eto.eto}`, honmeisei: ki.name },
      };
    },
  },

  // ⑪ ホロスコープ詳細
  "horoscope-deep": {
    system: `あなたは本格的な西洋占星術師です。以下の確定済みデータを元に、その人の本質・魂のテーマ・今後の流れを神秘的で詳しい文体で日本語で伝えてください。太陽星座・月星座は変えないでください。出生時刻・出生地からアセンダントの考察も加えてください。500文字程度で。`,
    build(body) {
      const { birthdate, birthTime, birthPlace, zodiacSign, moonSign } = body;
      const sign = zodiacSign || getSunSign(birthdate);
      return {
        user: `生年月日：${birthdate}\n太陽星座：${sign}\n月星座：${moonSign}\n出生時刻：${birthTime}\n出生地：${birthPlace}`,
        extra: { sunSign: sign, moonSign },
      };
    },
  },

  // ⑫ タロット一枚引き
  "tarot": {
    system: `あなたは神秘的なタロット占い師です。引いたカードのエネルギーと意味を、今この瞬間のユーザーへのメッセージとして神秘的な文体で日本語で届けてください。300文字程度で。`,
    build(body) {
      return { user: `引いたカード：${body.card}` };
    },
  },

  // ⑬ ルーン占い
  "rune-reading": {
    system: `あなたは北欧の神秘を伝えるルーン占い師です。引いたルーン文字の古代的な意味・エネルギー・今の状況へのメッセージを神秘的な文体で日本語で届けてください。300文字程度で。`,
    build(body) {
      return { user: `引いたルーン：${body.rune}` };
    },
  },

  // ⑭ オラクルカード
  "oracle-cards": {
    system: `あなたは宇宙のメッセージを伝えるオラクルカードリーダーです。テーマとカードを受け取り、今この瞬間の宇宙からの神秘的なメッセージを詩的な日本語で届けてください。300文字程度で。`,
    build(body) {
      return { user: `テーマ：${body.theme}、カード：${body.card}` };
    },
  },

  // ⑮ 九宮格診断
  "nine-palace": {
    system: `あなたは九宮格（風水×気学）の達人です。以下の確定済みデータを元に、今のあなたの運気の流れと開運の鍵を神秘的な文体で日本語で伝えてください。本命星は変えないでください。350文字程度で。`,
    build(body) {
      const { selectedPalace, birthdate, honmeisei: clientHonmei, honmeiseiNum: clientNum } = body;
      const ki = clientHonmei ? { name: clientHonmei, num: clientNum } : getNineStarKi(birthdate);
      return {
        user: `生年月日：${birthdate}、本命星：${ki.name}（${ki.num}）、直感で選んだ宮：${selectedPalace}`,
        extra: { honmeisei: ki.name, honmeiseiNum: ki.num },
      };
    },
  },

  // ⑯ 前世診断
  "past-life": {
    system: `あなたは魂の記憶を読む前世占い師です。ユーザーの回答から前世の物語を読み解き、魂が歩んできた旅を神秘的で詩的な日本語で語ってください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑰ 前世の職業診断
  "past-profession": {
    system: `あなたは魂の過去を読む前世職業占い師です。ユーザーの回答から前世で担っていた職業・役割（神官、騎士、薬師、吟遊詩人など）を特定し、その魂が持つスキルと今世への影響を神秘的な文体で日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑱ 魂の使命診断
  "soul-mission": {
    system: `あなたは魂の設計図を読む占い師です。ユーザーの回答から今世の魂の使命・ライフテーマ・与えるべきギフトを読み解き、宇宙からのメッセージとして神秘的な文体で日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑲ 精霊動物診断
  "spirit-animal": {
    system: `あなたはシャーマニックな精霊動物ガイドです。ユーザーの回答から守護精霊動物を特定し、その動物のエネルギー・もたらすメッセージ・今週の指針を神秘的な文体で日本語で届けてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ⑳ オーラカラー診断
  "aura-reading": {
    system: `あなたはオーラを視るスピリチュアルリーダーです。ユーザーの回答から現在のオーラカラーを特定し、そのエネルギーの意味・魂の状態・今週の開運カラーを神秘的な文体で日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { user: `回答：${JSON.stringify(body.answers)}` };
    },
  },

  // ㉑ チャクラ診断
  "chakra-check": {
    system: `あなたはチャクラを診るエネルギーヒーラーです。以下の確定済みデータを元に、そのチャクラの意味・滞りの原因・解放のための実践・魂のメッセージを神秘的な文体で日本語で伝えてください。チャクラ名は変えないでください。400文字程度で。`,
    build(body) {
      const { answers, chakra, chakraNum } = body;
      const chakraDesc = chakra ? `特定チャクラ：${chakra}（${chakraNum}）` : `回答：${JSON.stringify(answers)}`;
      return {
        user: `${chakraDesc}\n感情の詰まり：${answers.q2}\n意識したいテーマ：${answers.q3}`,
        extra: { chakra, chakraNum },
      };
    },
  },

  // ㉒ オラクルメッセージ
  "oracle-message": {
    system: `あなたは宇宙のチャネラーです。ユーザーの今の気持ちや状況を受け取り、宇宙からの神秘的なメッセージを詩的な日本語で届けてください。150〜200文字程度で。`,
    build(body) {
      return { user: `今の気持ち・状況：${body.feeling}` };
    },
  },

  // ㉓ 夢解読AI
  "dream-decoder": {
    system: `あなたはスピリチュアルな夢解読師です。ユーザーが見た夢の内容を受け取り、象徴・潜在意識・スピリチュアルな意味を神秘的な文体で日本語で解説してください。300文字程度で。`,
    build(body) {
      return { user: `夢の内容：${body.dream}` };
    },
  },

  // ㉔ 縁結び相性診断
  "soul-compatibility": {
    system: `あなたは魂の縁を読む占い師です。以下の確定済みデータを元に、2人の魂レベルの相性・絆の意味・共に成長するための鍵を神秘的な文体で日本語で届けてください。星座とライフパスナンバーは変えないでください。300文字程度で。`,
    build(body) {
      const { birthdate1, birthdate2 } = body;
      const s1 = getSunSign(birthdate1), s2 = getSunSign(birthdate2);
      const l1 = getLifePathNumber(birthdate1), l2 = getLifePathNumber(birthdate2);
      return {
        user: `1人目：生年月日${birthdate1}・${s1}・ライフパスナンバー${l1}\n2人目：生年月日${birthdate2}・${s2}・ライフパスナンバー${l2}`,
        extra: { person1: { sign: s1, lpn: l1 }, person2: { sign: s2, lpn: l2 } },
      };
    },
  },

  // ㉕ 夢の色彩診断
  "dream-colors": {
    system: `あなたは色彩心理とスピリチュアルを組み合わせた夢解読師です。夢に現れた色の組み合わせから潜在意識のメッセージ・魂の状態・今必要なエネルギーを神秘的な文体で日本語で伝えてください。300文字程度で。`,
    build(body) {
      return { user: `夢に出た色：${body.colors.join("、")}` };
    },
  },

  // ㉖ 月相ジャーナル
  "moon-journal": {
    system: `あなたは月の神秘を語る案内人です。以下の確定済み月相データを元に、内省のための問いかけと月からのメッセージを詩的な日本語で届けてください。月相名は変えないでください。250文字程度で。`,
    build(body) {
      const today = body.today || new Date().toISOString().split("T")[0];
      const moonPhase = body.moonPhase || null;
      const moonAge = body.moonAge ?? null;
      const phaseDesc = moonPhase ? `月相：${moonPhase}（月齢約${moonAge}日）` : `今日の日付：${today}`;
      return { user: `今日の日付：${today}\n${phaseDesc}`, extra: { moonPhase, moonAge } };
    },
  },

  // ㉗ 今日の宇宙メッセージ
  "cosmic-message": {
    system: `あなたは宇宙の意識とつながるチャネラーです。以下の確定済み日付データを元に、今日この日の宇宙的エネルギーと地球上のすべての魂へのメッセージを詩的で神秘的な日本語で届けてください。宇宙数は変えないでください。250文字程度で。`,
    build(body) {
      const today = body.today || new Date().toISOString().split("T")[0];
      const cosmicNumber = body.cosmicNumber ?? null;
      const numDesc = cosmicNumber !== null ? `\n今日の宇宙数：${cosmicNumber}` : '';
      return { user: `今日の日付：${today}${numDesc}`, extra: { cosmicNumber } };
    },
  },

  // ㉘ 今日の開運カラー
  "lucky-color": {
    system: `あなたは色彩運気の占い師です。以下の確定済みデータを元に、今日最も開運をもたらすラッキーカラーを特定し、その色のエネルギー・使い方・今日のアドバイスを神秘的な文体で日本語で伝えてください。本命星・星座・数字は変えないでください。300文字程度で。`,
    build(body) {
      const { birthdate, targetDate } = body;
      const ki = getNineStarKi(birthdate);
      const sign = getSunSign(birthdate);
      const lpn = getLifePathNumber(birthdate);
      return {
        user: `生年月日：${birthdate}\n対象日：${targetDate}\n本命星：${ki.name}\n太陽星座：${sign}\nライフパスナンバー：${lpn}`,
        extra: { honmeisei: ki.name, sign, lifePathNumber: lpn },
      };
    },
  },

  // ㉙ パワーストーン診断
  "crystal-guide": {
    system: `あなたはクリスタルヒーラーです。ユーザーの今の状態を受け取り、最も必要なパワーストーン（水晶、アメジスト、ローズクォーツなど）を特定し、その石のエネルギー・使い方・癒しのメッセージを神秘的な文体で日本語で伝えてください。350文字程度で。`,
    build(body) {
      return { user: `今の状態：${body.currentState}` };
    },
  },

  // ㉚ 手相占い（Vision API使用）
  "palm-reading": {
    vision: true,
    system: `あなたは神秘的な手相占い師です。手のひらの画像を見て、生命線・感情線・頭脳線・運命線・太陽線を丁寧に読み取り、その人の生命力・感情パターン・知性・運命の流れを神秘的で詩的な日本語で伝えてください。400文字程度で。`,
    build(body) {
      return { imageBase64: body.imageBase64, mimeType: body.mimeType || "image/jpeg" };
    },
  },
};

// 占いリクエスト共通ハンドラ。
// READINGS を参照して「確定計算 → Claude 呼び出し → JSONレスポンス」を行う。
// 認証・サブスク・入力バリデーション・レートリミットは呼び出し側（fetch）で実施済み。
async function handleMysticRequest(action, body, env, userId) {
  const reading = READINGS[action];
  if (!reading) return jsonResponse({ error: "Not Found" }, 404);
  const built = reading.build(body);
  const system = built.system || reading.system;
  const result = reading.vision
    ? await callClaudeVision(env, system, built.imageBase64, built.mimeType)
    : await callClaude(env, system, built.user);

  // 占い結果を履歴に保存（result + extra のみ。imageBase64 等の入力は保存しない）
  if (userId) {
    await saveHistory(env, userId, {
      action,
      result,
      createdAt: new Date().toISOString(),
      extra: built.extra || {},
    });
  }

  return jsonResponse({ result, ...(built.extra || {}) });
}

// ============================================
// 毎朝の占いメール — 配信内容生成 & 送信
// ============================================

// メール配信対象の占い（mail-pref で選択可能な appId と表示用 label/icon）。
// 占い本文は generateMailReading() が READINGS（handleMysticRequest）で都度生成する。
const DAILY_MAIL_APPS = {
  tarot_draw:     { label: "タロット一枚引き",   icon: "🃏" },
  rune_reading:   { label: "ルーン占い",         icon: "ᚱ" },
  oracle_message: { label: "オラクルメッセージ", icon: "🌌" },
  moon_journal:   { label: "月相ジャーナル",     icon: "📔" },
};

// mail-pref の appId → READINGS のアクション。
const MAIL_APP_TO_ACTION = {
  tarot_draw:     "tarot",
  rune_reading:   "rune-reading",
  oracle_message: "oracle-message",
  moon_journal:   "moon-journal",
};

// ============================================
// プロフィール（生年月日・登録名）
// KVキー: profile:<userId> → { birthdate?, name? }
// メールのパーソナライズに使用。未設定でも占い配信は成立する。
// ============================================
const PROFILE_PREFIX = "profile:";

async function getProfile(userId, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(PROFILE_PREFIX + userId);
    if (!data) return {};
    const p = JSON.parse(data);
    return (p && typeof p === "object" && !Array.isArray(p)) ? p : {};
  } catch {
    return {};
  }
}

const PROFILE_NAME_MAX = 50;

// GET  /profile → 現在のプロフィール（未設定なら {}）
// POST /profile → { birthdate?, name? } を検証して保存（既存値へマージ）
async function handleProfile(request, env) {
  const userId = await authenticate(request, env);
  if (!userId) return jsonResponse({ error: "認証が必要です" }, 401);

  if (request.method === "GET") {
    return jsonResponse({ profile: await getProfile(userId, env) });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonResponse({ error: "Invalid input" }, 400);
    }

    // 提供されたフィールドのみ検証（birthdate は既存バリデーションを流用 / name は50文字以内・空文字NG）
    const update = {};
    if (body.birthdate !== undefined) {
      if (!validateInput("birthdate", body.birthdate)) return jsonResponse({ error: "Invalid input" }, 400);
      update.birthdate = body.birthdate;
    }
    if (body.name !== undefined) {
      if (typeof body.name !== "string") return jsonResponse({ error: "Invalid input" }, 400);
      const name = body.name.trim();
      if (name.length === 0 || name.length > PROFILE_NAME_MAX) return jsonResponse({ error: "Invalid input" }, 400);
      update.name = name;
    }
    if (Object.keys(update).length === 0) return jsonResponse({ error: "Invalid input" }, 400);

    // レートリミット（ユーザーあたり 10回/時）
    if (!await checkRateLimit(env, "profile", userId)) {
      return jsonResponse({ error: "Too many requests" }, 429);
    }

    const profile = { ...(await getProfile(userId, env)), ...update };
    await env.MYSTIC_SUBSCRIPTIONS.put(PROFILE_PREFIX + userId, JSON.stringify(profile));
    return jsonResponse({ success: true, profile });
  }

  return jsonResponse({ error: "Method Not Allowed" }, 405);
}

// プロフィール（登録名・生年月日→星座）からメール冒頭の挨拶文を組み立てる。
function buildMailGreeting(profile) {
  const name = (profile && typeof profile.name === "string") ? profile.name.trim() : "";
  const sign = (profile && validateInput("birthdate", profile.birthdate)) ? getSunSign(profile.birthdate) : "";
  const hello = name ? `${name}さん、おはようございます。` : "おはようございます。";
  const line = sign
    ? `今日の${sign}のあなたへ、星々からのメッセージをお届けします。`
    : "今日のあなたへ、星々からのメッセージをお届けします。";
  return `${hello}\n${line}`;
}

// メール用の占いを1件生成する。appId を READINGS のアクションへ対応づけ、
// 必要な入力（ランダムなカード/ルーン等）を組み立てて handleMysticRequest() で実行する。
// 履歴（history:<userId>）を汚さないため userId は渡さない。
async function generateMailReading(appId, today, env) {
  const action = MAIL_APP_TO_ACTION[appId];
  if (!action) return null;

  let title, body;
  switch (appId) {
    case "tarot_draw": {
      const card = TAROT_CARDS[Math.floor(Math.random() * TAROT_CARDS.length)];
      title = `タロット一枚引き — 「${card}」`;
      body = { card };
      break;
    }
    case "rune_reading": {
      const rune = RUNE_NAMES[Math.floor(Math.random() * RUNE_NAMES.length)];
      title = `ルーン占い — ${rune}`;
      body = { rune };
      break;
    }
    case "oracle_message":
      title = "今日のオラクルメッセージ";
      body = { feeling: `新しい一日（${today}）の始まりに、宇宙からのメッセージを受け取りたい。` };
      break;
    case "moon_journal":
      title = `月相ジャーナル — ${today}`;
      body = { today };
      break;
    default:
      return null;
  }

  const res = await handleMysticRequest(action, body, env);
  const data = await res.json().catch(() => ({}));
  if (!data || !data.result) throw new Error(data.error || "占い結果を取得できませんでした");
  return { title, body: data.result };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function buildDailyMailHtml(today, sections, greeting = "") {
  const sectionsHtml = sections.map(s => `
    <tr><td style="padding:0 28px 24px;">
      <div style="background:#11112a;border:1px solid #2a2a4a;border-radius:14px;padding:24px;">
        <p style="margin:0 0 10px;font-size:14px;letter-spacing:.08em;color:#f0d080;">${s.icon || "✦"} ${escapeHtml(s.title)}</p>
        <p style="margin:0;font-size:14px;line-height:1.9;color:#e8e0f0;white-space:pre-wrap;">${escapeHtml(s.body)}</p>
      </div>
    </td></tr>`).join("");

  const greetingHtml = greeting ? `
        <tr><td style="padding:0 28px 24px;">
          <p style="margin:0;font-size:14px;line-height:1.9;color:#e8e0f0;white-space:pre-wrap;text-align:center;">${escapeHtml(greeting)}</p>
        </td></tr>` : "";

  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#05050f;font-family:'Hiragino Mincho ProN','Yu Mincho',Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05050f;">
    <tr><td align="center" style="padding:36px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="padding:0 28px 28px;text-align:center;">
          <p style="margin:0;font-size:13px;letter-spacing:.3em;color:#c49bff;">✦ とむMYSTIC ✦</p>
          <p style="margin:8px 0 0;font-size:12px;letter-spacing:.15em;color:#8880a8;">${escapeHtml(today)} の占いをお届けします</p>
        </td></tr>
        ${greetingHtml}
        ${sectionsHtml}
        <tr><td style="padding:4px 28px 0;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:.1em;color:#8880a8;">配信設定の変更は とむMYSTIC マイページから行えます</p>
          <p style="margin:0;font-size:10px;letter-spacing:.15em;color:#8880a8;">© 2026 とむMYSTIC</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendDailyMail(env, to, today, sections, greeting = "") {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "とむMYSTIC <noreply@tomu-ai.dev>",
      to: [to],
      subject: `今日の占い ✨ ${today}`,
      html: buildDailyMailHtml(today, sections, greeting),
    }),
  });
  if (!res.ok) {
    console.error(`Resend送信失敗 (${to}): ${await res.text()}`);
  }
}

// ============================================
// 毎朝の占いメール — Cronによる配信処理
// Cronは全ユーザーを走査してQueuesにジョブを積むだけ。
// 実際のメール配信は queue コンシューマー（processDailyMailUser）が担う。
// hour / today は積んだ時点（Cron発火時刻）の値を各ジョブに含めて整合性を保つ。
// ============================================

function jstParts(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return { hour: jst.getUTCHours(), dateString: jst.toISOString().split("T")[0] };
}

async function runDailyMail(env) {
  if (!env.RESEND_API_KEY) return;

  const { hour: currentHour, dateString: today } = jstParts(new Date());

  let cursor;
  do {
    const list = await env.MYSTIC_SUBSCRIPTIONS.list({ prefix: MAIL_PREF_PREFIX, cursor });
    for (const key of list.keys) {
      const userId = key.name.slice(MAIL_PREF_PREFIX.length);
      await env.MAIL_QUEUE.send({ userId, hour: currentHour, today });
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

async function processDailyMailUser(userId, currentHour, today, env) {
  try {
    const data = await env.MYSTIC_SUBSCRIPTIONS.get(MAIL_PREF_PREFIX + userId);
    if (!data) return;

    const pref = JSON.parse(data);
    if (!pref.enabled || pref.hour !== currentHour || !Array.isArray(pref.apps) || !pref.apps.length) return;

    const isSubscribed = await checkSubscription(userId, env);
    if (!isSubscribed) return;

    let email;
    try { email = atob(userId); } catch { return; }
    if (!email.includes("@")) return;

    // プロフィール（生年月日・登録名）を取得してパーソナライズ（未設定でも続行）
    const profile = await getProfile(userId, env);

    const sections = [];
    for (const appId of pref.apps) {
      const mailApp = DAILY_MAIL_APPS[appId];
      if (!mailApp) continue;
      try {
        const reading = await generateMailReading(appId, today, env);
        if (reading) sections.push({ ...reading, icon: mailApp.icon });
      } catch (err) {
        // AI生成失敗時はその占いをスキップし、他の占い・メール送信は続行
        console.error(`占い生成失敗 [${appId}] (${email}): ${err.message}`);
      }
    }
    if (!sections.length) return;

    await sendDailyMail(env, email, today, sections, buildMailGreeting(profile));
  } catch (err) {
    console.error(`メール配信処理エラー (${userId}): ${err.message}`);
  }
}

// ============================================
// ユーティリティ
// ============================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

const MYSTIC_LEGAL_STYLE = `<style>
:root {
  --bg: #05050f;
  --surface: #0d0d1e;
  --card: #11112a;
  --border: #2a2a4a;
  --accent: #c49bff;
  --accent2: #7ec8e3;
  --gold: #f0d080;
  --text: #e8e0f0;
  --muted: #8880a8;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', Georgia, serif;
  line-height: 1.8;
}
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background:
    radial-gradient(ellipse at 20% 50%, rgba(100,60,180,.12) 0%, transparent 60%),
    radial-gradient(ellipse at 80% 20%, rgba(60,120,200,.10) 0%, transparent 50%);
  pointer-events: none;
  z-index: 0;
}
header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  padding: 1rem 2rem;
  border-bottom: 1px solid var(--border);
  background: rgba(5,5,15,.9);
  backdrop-filter: blur(10px);
}
.logo {
  font-size: 1rem;
  letter-spacing: .25em;
  color: var(--accent);
  text-decoration: none;
  text-transform: uppercase;
}
main {
  position: relative;
  z-index: 1;
  max-width: 760px;
  margin: 0 auto;
  padding: 3rem 1.5rem 5rem;
}
h1 {
  font-size: 1.75rem;
  font-weight: 400;
  letter-spacing: 0.1em;
  color: var(--accent);
  margin-bottom: 2rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
h2 {
  font-size: 1.05rem;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: var(--gold);
  margin: 2.5rem 0 0.75rem;
}
p { margin-bottom: 1rem; font-size: 0.875rem; color: var(--text); }
ul { margin: 0.5rem 0 1rem 1.4rem; font-size: 0.875rem; }
ul li { padding: 0.15rem 0; color: var(--text); }
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 3rem;
  font-size: 0.875rem;
}
th, td {
  padding: 1rem 1.2rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
th {
  width: 34%;
  background: var(--card);
  font-weight: 400;
  color: var(--muted);
  letter-spacing: 0.04em;
}
td { background: var(--surface); color: var(--text); }
.price-list { margin: 0; padding: 0; list-style: none; }
.price-list li { padding: 0.25rem 0; display: flex; align-items: baseline; gap: 0.6rem; }
.price-badge {
  display: inline-block;
  background: var(--accent);
  color: var(--bg);
  font-size: 0.65rem;
  padding: 0.1rem 0.55rem;
  border-radius: 3px;
  letter-spacing: 0.06em;
  white-space: nowrap;
}
.effective-date { font-size: 0.8rem; color: var(--muted); margin-bottom: 2.5rem; }
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  color: var(--accent);
  text-decoration: none;
  font-size: 0.85rem;
  letter-spacing: 0.04em;
  border-bottom: 1px solid transparent;
  transition: border-color .2s;
  margin-top: 2rem;
}
.back-link:hover { border-color: var(--accent); }
footer {
  position: relative;
  z-index: 1;
  border-top: 1px solid var(--border);
  padding: 2rem;
  text-align: center;
  font-size: 0.65rem;
  letter-spacing: 0.15em;
  color: var(--muted);
}
@media(max-width:640px){ main { padding: 2rem 1rem 4rem; } th { width: 40%; } }
</style>`;

const MYSTIC_LEGAL_NAV = `<header>
  <a href="https://tomu-ai963.github.io/tomu-mystic/" class="logo">✦ とむMYSTIC</a>
</header>`;

const MYSTIC_TOKUSHOHO_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>特定商取引法に基づく表記 — とむMYSTIC</title>
${MYSTIC_LEGAL_STYLE}
</head>
<body>
${MYSTIC_LEGAL_NAV}
<main>
  <h1>✦ 特定商取引法に基づく表記</h1>
  <table>
    <tr>
      <th>運営者・運営責任者</th>
      <td>藤山　博史</td>
    </tr>
    <tr>
      <th>所在地・電話番号</th>
      <td>請求があった場合には速やかに開示いたします</td>
    </tr>
    <tr>
      <th>メールアドレス</th>
      <td>Inverted.triangle.leef@gmail.com</td>
    </tr>
    <tr>
      <th>販売価格</th>
      <td>
        <ul class="price-list">
          <li><span class="price-badge">ライト</span>月額 480円（税込）</li>
          <li><span class="price-badge">スタンダード</span>月額 980円（税込）</li>
          <li><span class="price-badge">フル</span>月額 1,480円（税込）</li>
        </ul>
      </td>
    </tr>
    <tr>
      <th>支払方法</th>
      <td>クレジットカード（Stripe決済）</td>
    </tr>
    <tr>
      <th>サービス提供時期</th>
      <td>決済完了後即時</td>
    </tr>
    <tr>
      <th>返金・キャンセル</th>
      <td>月途中のキャンセルによる返金は行いません</td>
    </tr>
  </table>
  <a href="https://tomu-ai963.github.io/tomu-mystic/" class="back-link">← トップページに戻る</a>
</main>
<footer>© 2026 とむMYSTIC. All rights reserved.</footer>
</body>
</html>`;

const MYSTIC_PRIVACY_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>プライバシーポリシー — とむMYSTIC</title>
${MYSTIC_LEGAL_STYLE}
</head>
<body>
${MYSTIC_LEGAL_NAV}
<main>
  <h1>✦ プライバシーポリシー</h1>
  <p class="effective-date">制定日：2026年1月1日</p>

  <p>とむMYSTIC（以下「本サービス」）は、ユーザーの個人情報の取り扱いについて以下のとおり定めます。</p>

  <h2>1. 収集する個人情報</h2>
  <p>本サービスは、以下の情報を収集する場合があります。</p>
  <ul>
    <li>メールアドレス（ログイン・サブスクリプション管理・お問い合わせ時）</li>
    <li>決済関連情報（Stripe社を通じた処理。カード番号等はStripe社が管理し、本サービスは保持しません）</li>
    <li>サービス利用状況（AI機能の利用回数・プラン情報）</li>
  </ul>

  <h2>2. 利用目的</h2>
  <p>収集した個人情報は、以下の目的で利用します。</p>
  <ul>
    <li>本サービスの提供・運営・改善</li>
    <li>サブスクリプションプランの管理</li>
    <li>利用制限・不正利用の検知</li>
    <li>お問い合わせへの対応</li>
    <li>重要なお知らせの送信</li>
  </ul>

  <h2>3. 第三者への提供</h2>
  <p>本サービスは、以下の場合を除き、個人情報を第三者に提供しません。</p>
  <ul>
    <li>法令に基づき開示が必要な場合</li>
    <li>ユーザーの同意がある場合</li>
  </ul>
  <p>なお、本サービスは以下の外部サービスを利用しています。</p>
  <ul>
    <li>Stripe, Inc.（決済処理）</li>
    <li>Anthropic, PBC（AI機能）</li>
    <li>Cloudflare, Inc.（インフラ・ホスティング）</li>
  </ul>

  <h2>4. Cookie・アクセス解析</h2>
  <p>本サービス独自のアクセス解析ツールは現時点では導入していません。</p>

  <h2>5. 個人情報の管理</h2>
  <p>収集した個人情報は、Cloudflare Workers KVにて管理し、適切なアクセス制御を実施しています。サービス退会後、不要となった情報は速やかに削除します。</p>

  <h2>6. ポリシーの変更</h2>
  <p>本ポリシーの内容は、法令の改正やサービス変更に応じて予告なく変更する場合があります。変更後の内容は、本ページに掲載した時点から効力を生じます。</p>

  <h2>7. お問い合わせ</h2>
  <p>個人情報の取り扱いに関するお問い合わせは、下記メールアドレスまでご連絡ください。</p>
  <p>Inverted.triangle.leef@gmail.com</p>

  <a href="https://tomu-ai963.github.io/tomu-mystic/" class="back-link">← トップページに戻る</a>
</main>
<footer>© 2026 とむMYSTIC. All rights reserved.</footer>
</body>
</html>`;

// ============================================
// MCP 用追加定数・ユーティリティ
// ============================================

const RUNE_NAMES = [
  "フェフ（富と繁栄）","ウルズ（力と野性）","スリサズ（保護と試練）",
  "アンサズ（知恵と啓示）","ライゾ（旅と変化）","ケナズ（創造と洞察）",
  "ゲボ（贈り物と交換）","ウィンジョ（喜びと調和）","ハガラズ（破壊と変革）",
  "ナウシズ（必要性と抵抗）","イサズ（静止と内省）","イェラ（収穫と循環）",
  "イワズ（永続と保護）","ペルズ（秘密と神秘）","アルギズ（守護と高次意識）",
  "ソウィロ（太陽と勝利）","ティワズ（正義と犠牲）","ベルカノ（成長と誕生）",
  "エワズ（変化と忠誠）","マンナズ（人類と自己）","ラグズ（水と直感）",
  "イングワズ（豊穣と完成）","ダガズ（夜明けと変容）","オシラ（家と遺産）",
];

const I_CHING_HEXAGRAMS = [
  "乾（けん）- 天の創造力","坤（こん）- 大地の受容","屯（ちゅん）- 草創の困難",
  "蒙（もう）- 若さと教育","需（じゅ）- 待つこと","訟（しょう）- 争い",
  "師（し）- 軍と大衆","比（ひ）- 結束","小畜（しょうちく）- 小さな蓄積",
  "履（り）- 行為","泰（たい）- 平和","否（ひ）- 停滞",
  "同人（どうじん）- 人との結合","大有（たいゆう）- 大きな豊かさ","謙（けん）- 謙虚",
  "豫（よ）- 喜び","随（ずい）- 従う","蟲（こ）- 腐敗の修正",
  "臨（りん）- 接近","観（かん）- 観察","噬嗑（ぜいこう）- 咬み砕く",
  "賁（ひ）- 飾り","剥（はく）- 剥落","復（ふく）- 回帰",
  "無妄（むぼう）- 無邪気","大畜（たいちく）- 大きな蓄積","頤（い）- 養育",
  "大過（たいか）- 大きな過ぎること","坎（かん）- 深淵","離（り）- 火と光",
  "咸（かん）- 感応","恒（こう）- 永続","遯（とん）- 退却",
  "大壮（たいそう）- 大きな力","晋（しん）- 前進","明夷（めいい）- 光の傷",
  "家人（かじん）- 家族","睽（けい）- 対立","蹇（けん）- 障害",
  "解（かい）- 解放","損（そん）- 減少","益（えき）- 増加",
  "夬（かい）- 決断","姤（こう）- 出会い","萃（すい）- 集合",
  "升（しょう）- 上昇","困（こん）- 困窮","井（せい）- 井戸",
  "革（かく）- 革命","鼎（てい）- 鍋","震（しん）- 雷",
  "艮（ごん）- 山","漸（ぜん）- 徐々に","帰妹（きまい）- 花嫁",
  "豊（ほう）- 豊かさ","旅（りょ）- 旅人","巽（そん）- 風",
  "兌（だ）- 喜び","渙（かん）- 分散","節（せつ）- 節制",
  "中孚（ちゅうふ）- 内なる真実","小過（しょうか）- 小さな過ぎること","既済（きせい）- 完成",
  "未済（みせい）- 未完成",
];

const MERCURY_RETROGRADE_PERIODS = [
  ["2024-08-05","2024-08-28"],
  ["2024-11-25","2024-12-15"],
  ["2025-01-25","2025-02-15"],
  ["2025-05-29","2025-06-22"],
  ["2025-09-21","2025-10-15"],
  ["2026-01-25","2026-02-14"],
  ["2026-05-16","2026-06-09"],
  ["2026-09-11","2026-10-04"],
];

function checkMercuryRetrograde(dateStr) {
  const d = new Date(dateStr);
  for (const [start, end] of MERCURY_RETROGRADE_PERIODS) {
    if (d >= new Date(start) && d <= new Date(end)) {
      return { retrograde: true, period: `${start} 〜 ${end}` };
    }
  }
  return { retrograde: false };
}

function calcBiorhythm(birthdate, targetDate) {
  const days = Math.floor((new Date(targetDate) - new Date(birthdate)) / 86400000);
  return {
    physical:     Math.round(Math.sin(2 * Math.PI * days / 23) * 100),
    emotional:    Math.round(Math.sin(2 * Math.PI * days / 28) * 100),
    intellectual: Math.round(Math.sin(2 * Math.PI * days / 33) * 100),
  };
}

// ============================================
// MCP サーバー実装 (POST /mcp)
// JSON-RPC 2.0 ベース、@modelcontextprotocol/sdk 不使用
// ============================================

const MCP_TOOLS = [
  {
    name: "star_reading",
    description: "今日の星読み。生年月日から太陽星座を計算し、今日の宇宙エネルギーと星のメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "tarot_draw",
    description: "タロット一枚引き。ランダムにカードを引き、今この瞬間のメッセージを届けます。引数は不要です。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "numerology",
    description: "数秘術診断。生年月日からライフパスナンバーを計算し、魂の使命と今世のテーマを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        name:      { type: "string", description: "名前（任意）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "lucky_color",
    description: "今日の開運カラー。生年月日と対象日から最もラッキーなカラーを特定し、開運アドバイスを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:   { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        target_date: { type: "string", description: "対象日（YYYY-MM-DD形式）。省略時は今日。" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "oracle_message",
    description: "宇宙メッセージ。今の気持ちや状況・悩みを伝えると、宇宙からの神秘的なメッセージが届きます。",
    inputSchema: {
      type: "object",
      properties: {
        feeling: { type: "string", description: "今の気持ちや状況・悩み" },
      },
      required: ["feeling"],
    },
  },
  {
    name: "past_life",
    description: "前世診断。自己描写や好み・傾向を入力すると、AIが前世の物語を神秘的に語ります。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "あなたの特徴・好み・傾向・直感的に惹かれるものなど（自由記述）" },
      },
      required: ["description"],
    },
  },
  {
    name: "guardian_star",
    description: "守護星特定。生年月日から守護星を特定し、今週の指針と開運アドバイスを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "dream_reading",
    description: "夢解読AI。夢の内容を入力すると、スピリチュアルな視点から象徴と潜在意識のメッセージを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        dream: { type: "string", description: "見た夢の内容を詳しく記述してください" },
      },
      required: ["dream"],
    },
  },
  {
    name: "compatibility",
    description: "縁結び相性占い。2人の生年月日から魂レベルの相性・絆の意味・共に成長するための鍵を読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate1: { type: "string", description: "1人目の生年月日（YYYY-MM-DD形式）" },
        birthdate2: { type: "string", description: "2人目の生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate1", "birthdate2"],
    },
  },
  {
    name: "soul_mission",
    description: "魂の使命診断。今世のテーマ・使命・ライフギフトをAIが読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "自分が大切にしていること・繰り返すパターン・情熱を感じることなど（自由記述）" },
        birthdate:   { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["description"],
    },
  },
  {
    name: "moon_journal",
    description: "月相ジャーナル。今日の月相に合わせた内省プロンプトと月からのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        date:       { type: "string", description: "対象日（YYYY-MM-DD形式、省略時は今日）" },
        moon_phase: { type: "string", description: "月相名（例：新月、三日月、上弦の月、満月、下弦の月）省略可" },
      },
    },
  },
  {
    name: "aura_reading",
    description: "オーラ診断。今の状態・気分・エネルギーを入力すると、現在のオーラカラーを特定し読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        current_state: { type: "string", description: "今の気分・体の感覚・心の状態・最近の出来事など（自由記述）" },
      },
      required: ["current_state"],
    },
  },
  {
    name: "chakra_check",
    description: "チャクラバランス診断。気になる体の部位や感情・悩みを入力すると、滞っているチャクラを特定し解放メッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        concern: { type: "string", description: "気になる体の症状・感情・悩み・テーマ（自由記述）" },
      },
      required: ["concern"],
    },
  },
  {
    name: "power_stone",
    description: "パワーストーン診断。生年月日と今の状態から相性の良いパワーストーンを特定し、癒しのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:     { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
        current_state: { type: "string", description: "今の状態・悩み・求めているエネルギー（任意）" },
      },
    },
  },
  {
    name: "angel_number",
    description: "エンジェルナンバー解読。繰り返し見る数字や気になる数字を入力すると、天使からのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "string", description: "気になる数字（例：111、1234、777など）" },
      },
      required: ["number"],
    },
  },
  {
    name: "spirit_animal",
    description: "スピリットアニマル診断。自分の特徴・傾向・好みを入力すると、守護精霊動物とそのメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "自分の性格・好きな場所・本能的に惹かれる動物・傾向など（自由記述）" },
      },
      required: ["description"],
    },
  },
  {
    name: "mandala_reading",
    description: "マンダラ占い。1〜9の数字を直感で選ぶと、そのマンダラポジションのエネルギーと今のメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        position: { type: "number", description: "直感で選んだ数字（1〜9）" },
        question:  { type: "string", description: "今のテーマや質問（任意）" },
      },
      required: ["position"],
    },
  },
  {
    name: "rune_reading",
    description: "ルーン占い（一文字引き）。質問を入力するとルーン文字をランダムに引き、その意味とメッセージを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "今の質問・テーマ・悩み（任意）" },
      },
    },
  },
  {
    name: "i_ching",
    description: "易占い。質問を入力すると六十四卦からランダムに一卦を引き、今この瞬間の宇宙の答えを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "今の質問・悩み・判断を迫られていること" },
      },
      required: ["question"],
    },
  },
  {
    name: "biorhythm",
    description: "バイオリズム診断。生年月日から今日の肉体・感情・知性の3サイクルを計算し、コンディションと行動指針を届けます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:   { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        target_date: { type: "string", description: "診断したい日付（YYYY-MM-DD形式、省略時は今日）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "celtic_cross",
    description: "ケルト十字スプレッド。タロット10枚展開で状況・障害・過去・未来・深層など多面的な読みを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "占いたいテーマや質問" },
      },
      required: ["question"],
    },
  },
  {
    name: "yearly_forecast",
    description: "年間運勢予測。生年月日と対象年から総合運・愛情運・仕事運・金運の年間の流れを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        year:      { type: "number", description: "対象年（例：2026、省略時は今年）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "monthly_fortune",
    description: "月間運勢。生年月日と対象月からその月の運勢の流れ・注目時期・テーマを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate:  { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
        year_month: { type: "string", description: "対象年月（YYYY-MM形式、省略時は今月）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "love_oracle",
    description: "恋愛オラクル。恋愛に関する悩みや状況を入力すると、愛の神秘的なメッセージと指針を届けます。",
    inputSchema: {
      type: "object",
      properties: {
        situation: { type: "string", description: "今の恋愛状況・悩み・質問（自由記述）" },
      },
      required: ["situation"],
    },
  },
  {
    name: "career_reading",
    description: "仕事・キャリア占い。仕事の悩みや方向性の迷いを入力すると、魂の視点から最善のキャリアパスを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        concern:   { type: "string", description: "仕事・キャリアの悩みや質問（自由記述）" },
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["concern"],
    },
  },
  {
    name: "health_energy",
    description: "健康エネルギー診断。今の体の状態や気になる症状を入力すると、エネルギー的な視点から健康の指針を届けます。",
    inputSchema: {
      type: "object",
      properties: {
        concern:   { type: "string", description: "体の状態・気になる症状・疲れ感など（自由記述）" },
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["concern"],
    },
  },
  {
    name: "wealth_flow",
    description: "金運診断。生年月日から金運のサイクル・お金との関係性・今の流れと開運アクションを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式）" },
      },
      required: ["birthdate"],
    },
  },
  {
    name: "mercury_retrograde",
    description: "水星逆行チェック。指定した日が水星逆行期間中かどうかを確認し、その時期に合わせたアドバイスを届けます。",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "確認したい日付（YYYY-MM-DD形式、省略時は今日）" },
      },
    },
  },
  {
    name: "numerology_name",
    description: "姓名判断。氏名の漢字画数から五格（天格・人格・地格・外格・総格）を計算し、運命の流れを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        full_name: { type: "string", description: "氏名（姓と名をスペースで区切って入力。例：山田 花子）" },
      },
      required: ["full_name"],
    },
  },
  {
    name: "cosmic_timing",
    description: "宇宙のタイミング診断。今取り組もうとしていることを入力すると、今が行動すべき時かどうか宇宙の流れを読み解きます。",
    inputSchema: {
      type: "object",
      properties: {
        action:    { type: "string", description: "今取り組もうとしていること・決断しようとしていること（自由記述）" },
        birthdate: { type: "string", description: "生年月日（YYYY-MM-DD形式、任意）" },
      },
      required: ["action"],
    },
  },
];

const TAROT_CARDS = [
  "愚者", "魔術師", "女教皇", "女帝", "皇帝", "教皇", "恋人たち",
  "戦車", "力", "隠者", "運命の輪", "正義", "吊るされた男", "死神",
  "節制", "悪魔", "塔", "星", "月", "太陽", "審判", "世界",
];

async function handleMcp(request, env) {
  // MCP_TOKEN が未設定の場合は認証スキップせず拒否（誤設定によるAPI無料垂れ流しを防止）
  if (!env.MCP_TOKEN) {
    return mcpError(null, -32001, "Unauthorized", 401);
  }

  // Streamable HTTP: GET リクエストにはサーバー情報を返す
  if (request.method === "GET") {
    return new Response(JSON.stringify({
      name: "tomu-mystic",
      version: "1.0.0",
      protocolVersion: "2024-11-05",
    }), {
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  // トークン照合（未設定ケースは上で401済み）
  const url = new URL(request.url);
  const token =
    url.searchParams.get("token") ??
    request.headers.get("X-MCP-Token") ??
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (token !== env.MCP_TOKEN) {
    return mcpError(null, -32001, "Unauthorized", 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return mcpError(null, -32700, "Parse error");
  }

  const { jsonrpc, id = null, method, params } = body;

  if (jsonrpc !== "2.0") {
    return mcpError(id, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }

  // 通知メッセージ（レスポンス不要）
  if (method === "notifications/initialized") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  switch (method) {
    case "initialize":
      return mcpResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tomu-mystic", version: "1.0.0" },
      });

    case "tools/list":
      return mcpResponse(id, { tools: MCP_TOOLS });

    case "tools/call":
      return handleMcpToolCall(id, params, env);

    default:
      return mcpError(id, -32601, `Method not found: ${method}`);
  }
}

async function handleMcpToolCall(id, params, env) {
  const { name, arguments: args = {} } = params || {};

  try {
    let text;

    switch (name) {
      case "star_reading": {
        const { birthdate } = args;
        if (!birthdate) return mcpError(id, -32602, "birthdate は必須です");
        const sign = getSunSign(birthdate);
        text = await callClaude(
          env,
          `あなたは神秘的な星読み師です。以下の確定済みデータを元に、今日の星の配置に基づいたメッセージを詩的で神秘的な文体で日本語で届けてください。星座の判定は変えないでください。200〜300文字程度で。`,
          `生年月日：${birthdate}\n太陽星座：${sign}`
        );
        text = `【太陽星座：${sign}】\n\n${text}`;
        break;
      }

      case "tarot_draw": {
        const card = TAROT_CARDS[Math.floor(Math.random() * TAROT_CARDS.length)];
        text = await callClaude(
          env,
          `あなたは神秘的なタロット占い師です。引いたカードのエネルギーと意味を、今この瞬間のユーザーへのメッセージとして神秘的な文体で日本語で届けてください。300文字程度で。`,
          `引いたカード：${card}`
        );
        text = `【引いたカード：${card}】\n\n${text}`;
        break;
      }

      case "numerology": {
        const { birthdate, name: userName = "（名前未入力）" } = args;
        if (!birthdate) return mcpError(id, -32602, "birthdate は必須です");
        const lpn = getLifePathNumber(birthdate);
        text = await callClaude(
          env,
          `あなたは数秘術の達人です。以下の確定済みライフパスナンバーを元に、魂の使命と今世のテーマを神秘的な文体で日本語で伝えてください。ライフパスナンバーの数値は変えないでください。300文字程度で。`,
          `名前：${userName}\n生年月日：${birthdate}\nライフパスナンバー：${lpn}`
        );
        text = `【ライフパスナンバー：${lpn}】\n\n${text}`;
        break;
      }

      case "lucky_color": {
        const { birthdate, target_date } = args;
        if (!birthdate) return mcpError(id, -32602, "birthdate は必須です");
        const targetDate = target_date || new Date().toISOString().split("T")[0];
        const ki   = getNineStarKi(birthdate);
        const sign = getSunSign(birthdate);
        const lpn  = getLifePathNumber(birthdate);
        text = await callClaude(
          env,
          `あなたは色彩運気の占い師です。以下の確定済みデータを元に、今日最も開運をもたらすラッキーカラーを特定し、その色のエネルギー・使い方・今日のアドバイスを神秘的な文体で日本語で伝えてください。本命星・星座・数字は変えないでください。300文字程度で。`,
          `生年月日：${birthdate}\n対象日：${targetDate}\n本命星：${ki.name}\n太陽星座：${sign}\nライフパスナンバー：${lpn}`
        );
        text = `【${targetDate}の開運カラー診断】\n\n${text}`;
        break;
      }

      case "oracle_message": {
        const { feeling } = args;
        if (!feeling) return mcpError(id, -32602, "feeling は必須です");
        text = await callClaude(
          env,
          `あなたは宇宙のチャネラーです。ユーザーの今の気持ちや状況を受け取り、宇宙からの神秘的なメッセージを詩的な日本語で届けてください。150〜200文字程度で。`,
          `今の気持ち・状況：${feeling}`
        );
        break;
      }

      case "past_life": {
        const { description: plDesc } = args;
        if (!plDesc) return mcpError(id, -32602, "description は必須です");
        text = await callClaude(
          env,
          `あなたは魂の記憶を読む前世占い師です。ユーザーの自己描写から前世の物語を読み解き、魂が歩んできた旅を神秘的で詩的な日本語で語ってください。400文字程度で。`,
          `自己描写・傾向：${plDesc}`
        );
        break;
      }

      case "guardian_star": {
        const { birthdate: gsBd } = args;
        if (!gsBd) return mcpError(id, -32602, "birthdate は必須です");
        const gsSign = getSunSign(gsBd);
        text = await callClaude(
          env,
          `あなたは星の守護者です。以下の確定済みデータを元に、守護星の性質と今週の指針・開運アドバイスを神秘的な文体で日本語で届けてください。星座は変えないでください。300文字程度で。`,
          `生年月日：${gsBd}\n太陽星座：${gsSign}`
        );
        text = `【守護星診断：${gsSign}】\n\n${text}`;
        break;
      }

      case "dream_reading": {
        const { dream } = args;
        if (!dream) return mcpError(id, -32602, "dream は必須です");
        text = await callClaude(
          env,
          `あなたはスピリチュアルな夢解読師です。ユーザーが見た夢の内容を受け取り、象徴・潜在意識・スピリチュアルな意味を神秘的な文体で日本語で解説してください。300文字程度で。`,
          `夢の内容：${dream}`
        );
        break;
      }

      case "compatibility": {
        const { birthdate1, birthdate2 } = args;
        if (!birthdate1 || !birthdate2) return mcpError(id, -32602, "birthdate1・birthdate2 は必須です");
        const cs1 = getSunSign(birthdate1), cs2 = getSunSign(birthdate2);
        const cl1 = getLifePathNumber(birthdate1), cl2 = getLifePathNumber(birthdate2);
        text = await callClaude(
          env,
          `あなたは魂の縁を読む占い師です。以下の確定済みデータを元に、2人の魂レベルの相性・絆の意味・共に成長するための鍵を神秘的な文体で日本語で届けてください。星座とライフパスナンバーは変えないでください。350文字程度で。`,
          `1人目：生年月日${birthdate1}・${cs1}・ライフパスナンバー${cl1}\n2人目：生年月日${birthdate2}・${cs2}・ライフパスナンバー${cl2}`
        );
        text = `【相性診断】1人目：${cs1}（LP:${cl1}）× 2人目：${cs2}（LP:${cl2}）\n\n${text}`;
        break;
      }

      case "soul_mission": {
        const { description: smDesc, birthdate: smBd } = args;
        if (!smDesc) return mcpError(id, -32602, "description は必須です");
        const smBdInfo = smBd ? `\n生年月日：${smBd}\nライフパスナンバー：${getLifePathNumber(smBd)}` : '';
        text = await callClaude(
          env,
          `あなたは魂の設計図を読む占い師です。ユーザーの記述から今世の魂の使命・ライフテーマ・与えるべきギフトを読み解き、宇宙からのメッセージとして神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `自己描写：${smDesc}${smBdInfo}`
        );
        break;
      }

      case "moon_journal": {
        const mjDate = args.date || new Date().toISOString().split("T")[0];
        const mjPhase = args.moon_phase || null;
        const mjPhaseDesc = mjPhase ? `月相：${mjPhase}` : `今日の日付：${mjDate}`;
        text = await callClaude(
          env,
          `あなたは月の神秘を語る案内人です。以下の確定済み月相データを元に、内省のための問いかけと月からのメッセージを詩的な日本語で届けてください。月相名は変えないでください。250文字程度で。`,
          `今日の日付：${mjDate}\n${mjPhaseDesc}`
        );
        text = `【月相ジャーナル：${mjDate}${mjPhase ? '・' + mjPhase : ''}】\n\n${text}`;
        break;
      }

      case "aura_reading": {
        const { current_state: arState } = args;
        if (!arState) return mcpError(id, -32602, "current_state は必須です");
        text = await callClaude(
          env,
          `あなたはオーラを視るスピリチュアルリーダーです。ユーザーの今の状態から現在のオーラカラーを特定し、そのエネルギーの意味・魂の状態・今週の開運カラーを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `今の状態：${arState}`
        );
        break;
      }

      case "chakra_check": {
        const { concern: ccConcern } = args;
        if (!ccConcern) return mcpError(id, -32602, "concern は必須です");
        text = await callClaude(
          env,
          `あなたはチャクラを診るエネルギーヒーラーです。ユーザーの悩みや症状から滞っているチャクラを特定し、そのチャクラの意味・滞りの原因・解放のための実践・魂のメッセージを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `気になる症状・悩み：${ccConcern}`
        );
        break;
      }

      case "power_stone": {
        const { birthdate: psBd, current_state: psState } = args;
        if (!psBd && !psState) return mcpError(id, -32602, "birthdate または current_state のいずれかは必須です");
        const psBdInfo = psBd ? `生年月日：${psBd}\n太陽星座：${getSunSign(psBd)}\n` : '';
        const psStateInfo = psState ? `今の状態：${psState}` : '';
        text = await callClaude(
          env,
          `あなたはクリスタルヒーラーです。以下のデータを元に最も相性の良いパワーストーンを特定し、その石のエネルギー・使い方・癒しのメッセージを神秘的な文体で日本語で伝えてください。350文字程度で。`,
          `${psBdInfo}${psStateInfo}`
        );
        break;
      }

      case "angel_number": {
        const { number: anNum } = args;
        if (!anNum) return mcpError(id, -32602, "number は必須です");
        text = await callClaude(
          env,
          `あなたは天使のメッセージを伝えるエンジェルナンバーリーダーです。ユーザーが繰り返し見る数字の意味・天使からのメッセージ・今この瞬間に必要な行動を神秘的な文体で日本語で届けてください。300文字程度で。`,
          `エンジェルナンバー：${anNum}`
        );
        text = `【エンジェルナンバー：${anNum}】\n\n${text}`;
        break;
      }

      case "spirit_animal": {
        const { description: saDesc } = args;
        if (!saDesc) return mcpError(id, -32602, "description は必須です");
        text = await callClaude(
          env,
          `あなたはシャーマニックな精霊動物ガイドです。ユーザーの自己描写から守護精霊動物を特定し、その動物のエネルギー・もたらすメッセージ・今週の指針を神秘的な文体で日本語で届けてください。400文字程度で。`,
          `自己描写・傾向：${saDesc}`
        );
        break;
      }

      case "mandala_reading": {
        const { position: mPos, question: mQuestion } = args;
        if (!mPos || mPos < 1 || mPos > 9) return mcpError(id, -32602, "position は1〜9の数字で入力してください");
        const mandalaPositions = [
          "中央（自己の核心・今の本質）","上（意識・理想・目標）","右（外の世界・行動・現実）",
          "下（潜在意識・基盤・過去）","左（内なる世界・直感・感情）","右上（光・才能・可能性）",
          "右下（現実化・物質・安定）","左下（影・課題・変容）","左上（夢・霊性・高次意識）",
        ];
        const mPosDesc = mandalaPositions[mPos - 1];
        const mQInfo = mQuestion ? `\n質問：${mQuestion}` : '';
        text = await callClaude(
          env,
          `あなたはマンダラ占いの達人です。ユーザーが直感で選んだポジションのエネルギーと意味、今この瞬間のメッセージを神秘的な文体で日本語で伝えてください。300文字程度で。`,
          `選んだポジション：${mPos}番（${mPosDesc}）${mQInfo}`
        );
        text = `【マンダラ第${mPos}番：${mPosDesc}】\n\n${text}`;
        break;
      }

      case "rune_reading": {
        const { question: rQuestion } = args;
        const rune = RUNE_NAMES[Math.floor(Math.random() * RUNE_NAMES.length)];
        const rQInfo = rQuestion ? `\n質問：${rQuestion}` : '';
        text = await callClaude(
          env,
          `あなたは北欧の神秘を伝えるルーン占い師です。引いたルーン文字の古代的な意味・エネルギー・今の状況へのメッセージを神秘的な文体で日本語で届けてください。300文字程度で。`,
          `引いたルーン：${rune}${rQInfo}`
        );
        text = `【引いたルーン：${rune}】\n\n${text}`;
        break;
      }

      case "i_ching": {
        const { question: icQuestion } = args;
        if (!icQuestion) return mcpError(id, -32602, "question は必須です");
        const hexagram = I_CHING_HEXAGRAMS[Math.floor(Math.random() * I_CHING_HEXAGRAMS.length)];
        text = await callClaude(
          env,
          `あなたは易経の達人です。引いた卦の意味・象意・今この質問への宇宙の答えを神秘的で深い文体で日本語で伝えてください。400文字程度で。`,
          `質問：${icQuestion}\n引いた卦：${hexagram}`
        );
        text = `【引いた卦：${hexagram}】\n\n${text}`;
        break;
      }

      case "biorhythm": {
        const { birthdate: bioBd, target_date: bioTd } = args;
        if (!bioBd) return mcpError(id, -32602, "birthdate は必須です");
        const bioTargetDate = bioTd || new Date().toISOString().split("T")[0];
        const bio = calcBiorhythm(bioBd, bioTargetDate);
        text = await callClaude(
          env,
          `あなたはバイオリズムを読む占い師です。指定日における肉体・感情・知性の3つのリズム値を受け取り、その人の今日のコンディションと取るべき行動指針を神秘的な文体で日本語で伝えてください。300文字程度で。`,
          `生年月日：${bioBd}\n対象日：${bioTargetDate}\n肉体リズム：${bio.physical}%\n感情リズム：${bio.emotional}%\n知性リズム：${bio.intellectual}%`
        );
        text = `【バイオリズム（${bioTargetDate}）】肉体：${bio.physical}% 感情：${bio.emotional}% 知性：${bio.intellectual}%\n\n${text}`;
        break;
      }

      case "celtic_cross": {
        const { question: ccQ } = args;
        if (!ccQ) return mcpError(id, -32602, "question は必須です");
        const ccShuffled = [...TAROT_CARDS].sort(() => Math.random() - 0.5);
        const ccPositions = [
          "現在の状況","交差（障害・助力）","遠い過去","近い過去",
          "可能性・最善策","近い未来","あなた自身","外的環境",
          "希望と恐れ","最終結果",
        ];
        const ccSpread = ccPositions.map((p, i) => `${p}：${ccShuffled[i]}`).join("\n");
        text = await callClaude(
          env,
          `あなたは深遠なタロット占い師です。ケルト十字スプレッドの10枚展開の意味を統合的に読み解き、状況・障害・過去・未来・深層を織り交ぜた神秘的なリーディングを日本語で届けてください。500文字程度で。`,
          `質問：${ccQ}\n\n${ccSpread}`,
          1000
        );
        text = `【ケルト十字スプレッド】\n${ccSpread}\n\n${text}`;
        break;
      }

      case "yearly_forecast": {
        const { birthdate: yfBd, year: yfYear } = args;
        if (!yfBd) return mcpError(id, -32602, "birthdate は必須です");
        const yfTargetYear = yfYear || new Date().getFullYear();
        const yfSign = getSunSign(yfBd);
        const yfLpn  = getLifePathNumber(yfBd);
        const yfKi   = getNineStarKi(yfBd);
        text = await callClaude(
          env,
          `あなたは年間運勢を読む占い師です。以下の確定済みデータを元に、対象年の総合運・愛情運・仕事運・金運・開運のポイントを神秘的な文体で日本語で伝えてください。星座・数字・本命星は変えないでください。500文字程度で。`,
          `生年月日：${yfBd}\n太陽星座：${yfSign}\nライフパスナンバー：${yfLpn}\n本命星：${yfKi.name}\n対象年：${yfTargetYear}年`,
          1000
        );
        text = `【${yfTargetYear}年の年間運勢】\n\n${text}`;
        break;
      }

      case "monthly_fortune": {
        const { birthdate: mfBd, year_month: mfYm } = args;
        if (!mfBd) return mcpError(id, -32602, "birthdate は必須です");
        const mfToday = new Date();
        const mfTargetYm = mfYm || `${mfToday.getFullYear()}-${String(mfToday.getMonth() + 1).padStart(2, '0')}`;
        const mfSign = getSunSign(mfBd);
        const mfLpn  = getLifePathNumber(mfBd);
        text = await callClaude(
          env,
          `あなたは月間運勢を読む占い師です。以下の確定済みデータを元に、対象月の全体的な流れ・注目すべき時期・テーマ・開運アクションを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `生年月日：${mfBd}\n太陽星座：${mfSign}\nライフパスナンバー：${mfLpn}\n対象月：${mfTargetYm}`
        );
        text = `【${mfTargetYm}の月間運勢】\n\n${text}`;
        break;
      }

      case "love_oracle": {
        const { situation: loSit } = args;
        if (!loSit) return mcpError(id, -32602, "situation は必須です");
        text = await callClaude(
          env,
          `あなたは愛のスピリチュアルリーダーです。ユーザーの恋愛状況を受け取り、愛の神秘的なメッセージ・心の扉を開く鍵・今この恋に必要な行動を詩的で神秘的な日本語で届けてください。350文字程度で。`,
          `恋愛状況・悩み：${loSit}`
        );
        break;
      }

      case "career_reading": {
        const { concern: crConcern, birthdate: crBd } = args;
        if (!crConcern) return mcpError(id, -32602, "concern は必須です");
        const crBdInfo = crBd ? `\n生年月日：${crBd}\n太陽星座：${getSunSign(crBd)}\nライフパスナンバー：${getLifePathNumber(crBd)}` : '';
        text = await callClaude(
          env,
          `あなたは魂の使命とキャリアを読む占い師です。ユーザーの仕事の悩みを受け取り、魂が本当に求める働き方・天職への道筋・今行動すべきことを神秘的な文体で日本語で伝えてください。400文字程度で。`,
          `仕事・キャリアの悩み：${crConcern}${crBdInfo}`
        );
        break;
      }

      case "health_energy": {
        const { concern: heConcern, birthdate: heBd } = args;
        if (!heConcern) return mcpError(id, -32602, "concern は必須です");
        const heBdInfo = heBd ? `\n生年月日：${heBd}\n太陽星座：${getSunSign(heBd)}` : '';
        text = await callClaude(
          env,
          `あなたはエネルギーメディシンとスピリチュアルヒーリングの専門家です。ユーザーの体の状態や症状を受け取り、エネルギー的な視点から健康の指針・必要なケア・魂からのメッセージを神秘的な文体で日本語で伝えてください。※医療的診断ではなくスピリチュアルな観点でのアドバイスです。400文字程度で。`,
          `体の状態・気になること：${heConcern}${heBdInfo}`
        );
        break;
      }

      case "wealth_flow": {
        const { birthdate: wfBd } = args;
        if (!wfBd) return mcpError(id, -32602, "birthdate は必須です");
        const wfSign = getSunSign(wfBd);
        const wfLpn  = getLifePathNumber(wfBd);
        const wfKi   = getNineStarKi(wfBd);
        text = await callClaude(
          env,
          `あなたは金運と豊かさの流れを読む占い師です。以下の確定済みデータを元に、その人の金運サイクル・お金との魂レベルの関係性・今の金運の流れ・開運アクションを神秘的な文体で日本語で伝えてください。本命星・星座・数字は変えないでください。400文字程度で。`,
          `生年月日：${wfBd}\n太陽星座：${wfSign}\nライフパスナンバー：${wfLpn}\n本命星：${wfKi.name}`
        );
        text = `【金運診断】\n\n${text}`;
        break;
      }

      case "mercury_retrograde": {
        const { date: mrDate } = args;
        const mrTargetDate = mrDate || new Date().toISOString().split("T")[0];
        const mrResult = checkMercuryRetrograde(mrTargetDate);
        const mrStatus = mrResult.retrograde
          ? `水星逆行中（期間：${mrResult.period}）`
          : "水星は順行中";
        text = await callClaude(
          env,
          `あなたは占星術師です。水星の状態に合わせたアドバイス・注意点・この時期の過ごし方を神秘的な文体で日本語で伝えてください。250文字程度で。`,
          `確認日：${mrTargetDate}\n水星の状態：${mrStatus}`
        );
        text = `【水星逆行チェック：${mrTargetDate}】\n${mrStatus}\n\n${text}`;
        break;
      }

      case "numerology_name": {
        const { full_name } = args;
        if (!full_name) return mcpError(id, -32602, "full_name は必須です");
        const nnCalc = calcGoKaku(full_name);
        const nnNote = nnCalc.unknown ? '\n※一部の漢字の画数が未登録です。' : '';
        text = await callClaude(
          env,
          `あなたは姓名判断の達人です。以下の画数は確定値です。この数値を使って運命の流れと今後の指針を神秘的な文体で日本語で伝えてください。絶対に画数を再計算しないでください。400文字程度で。`,
          `氏名：${full_name}
【確定済み五格 — 絶対に再計算しないでください】
天格：${nnCalc.tenkaku}（確定値）
人格：${nnCalc.jinkaku}（確定値）
地格：${nnCalc.chikaku}（確定値）
外格：${nnCalc.sotokaku}（確定値）
総格：${nnCalc.soukaku}（確定値）${nnNote}
以上の数値をそのまま使い、独自に画数を算出・修正しないでください。`
        );
        text = `【姓名判断：${full_name}】天格:${nnCalc.tenkaku} 人格:${nnCalc.jinkaku} 地格:${nnCalc.chikaku} 外格:${nnCalc.sotokaku} 総格:${nnCalc.soukaku}\n\n${text}`;
        break;
      }

      case "cosmic_timing": {
        const { action: ctAction, birthdate: ctBd } = args;
        if (!ctAction) return mcpError(id, -32602, "action は必須です");
        const ctToday = new Date().toISOString().split("T")[0];
        const ctBdInfo = ctBd ? `\n生年月日：${ctBd}\n太陽星座：${getSunSign(ctBd)}\nライフパスナンバー：${getLifePathNumber(ctBd)}` : '';
        text = await callClaude(
          env,
          `あなたは宇宙のタイミングを読む占い師です。ユーザーが取り組もうとしていることと今の宇宙の流れを照らし合わせ、今が行動すべき時かどうか・最適なタイミング・宇宙からのアドバイスを神秘的な文体で日本語で伝えてください。350文字程度で。`,
          `今日の日付：${ctToday}\n取り組もうとしていること：${ctAction}${ctBdInfo}`
        );
        break;
      }

      default:
        return mcpError(id, -32602, `Unknown tool: ${name}`);
    }

    return mcpResponse(id, {
      content: [{ type: "text", text }],
    });
  } catch (err) {
    console.error("MCP tool execution error:", err && (err.stack || err.message));
    return mcpError(id, -32603, "占いの取得に失敗しました。時間をおいて再度お試しください。");
  }
}

function mcpResponse(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function mcpError(id, code, message, httpStatus = 200) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
    { status: httpStatus, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
