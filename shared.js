// ============================================
// とむMYSTIC — shared.js
// モジュール横断の共通ユーティリティ:
//   CORS/レスポンス生成・入力検証・KVレートリミット・暗号ヘルパー・
//   サブスク状態参照・Claude API 呼び出し
// ============================================

import { DAILY_MAIL_APPS } from "./readings-data.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-MCP-Token, X-Admin-Token",
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

// userId（セッションID/メール等の識別子）: 非空・1〜254字・制御文字なし。
// KVキーやStripe metadataに使われるため、改行や制御文字の混入を弾く。
function isValidUserId(v) {
  return typeof v === "string" && v.length > 0 && v.length <= 254 && [...v].every(ch => { const c = ch.charCodeAt(0); return c >= 0x20 && c !== 0x7f; });
}

// プラン名: 未指定可。指定時は英数・ハイフン・アンダースコアのみ 1〜32字。
function isValidPlan(v) {
  return v === undefined || (typeof v === "string" && /^[a-z0-9_-]{1,32}$/i.test(v));
}

// リダイレクト許可オリジン（フロントの配信元）。Stripe の success/cancel と
// マジックリンクの復帰先の両方が参照するため、shared.js を唯一の定義源とする。
// （auth.js 側に置くと stripe.js → shared.js の参照が解決できない: cf. 6e556ce の分割事故）
const ALLOWED_REDIRECT_ORIGINS = ["https://tomu-ai963.github.io"];

// リダイレクトURL（Stripe success/cancel）: http(s) かつ許可オリジン or リクエスト自身のオリジンのみ。
// 外部オリジンへの誘導（オープンリダイレクト／XSS）を弾く。
function isAllowedRedirectUrl(raw, selfOrigin) {
  let u;
  // try/catch は URL のパース失敗だけに限定する。判定本体まで包むと、
  // 実装側のバグ（未定義参照など）まで「不正なURL」に化けて原因が隠れる。
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  return ALLOWED_REDIRECT_ORIGINS.includes(u.origin) || u.origin === selfOrigin;
}

// HTML エスケープ（メール本文・認証結果ページの文字列埋め込み用）
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ============================================
// レートリミット（KVベース）
// キー: rate:{type}:{identifier}:{YYYY-MM-DD-HH}（UTC時）、expirationTtl=3600で自動失効。
// 超過時は false を返す。KVアクセス失敗時は true（可用性優先で通過）。
// MYSTIC_SUBSCRIPTIONS KV を流用。
// ============================================

const RATE_LIMITS = {
  magic: 5,     // /auth/request-magic-link : メアドあたり 5回/時
  magicIp: 5,   // /auth/request-magic-link : IPあたり 5回/時（メアドを変えた爆撃・Resendクレジット消費対策）
  ai: 20,       // /api/mystic・/mystic/*    : ユーザーあたり 20回/時
  mailpref: 10, // /mail-pref POST           : ユーザーあたり 10回/時
  history: 60,  // /history/:index DELETE     : ユーザーあたり 60回/時
  profile: 10,  // /profile POST             : ユーザーあたり 10回/時
  communityPost: 10, // /community/post POST  : ユーザーあたり 10回/時
  communityLike: 60, // /community/like POST  : ユーザーあたり 60回/時
  stripe: 10,   // /stripe/checkout          : ユーザーあたり 10回/時（外部Stripe API乱用防止）
  cancel: 5,    // /subscription/cancel POST : ユーザーあたり 5回/時（受付メール送信を伴う）
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
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      // claude-sonnet-5 は thinking 未指定だと adaptive thinking がデフォルト有効。
      // thinking ブロックが content 先頭に入り max_tokens も消費するため明示的に無効化。
      thinking: { type: "disabled" },
      system: systemPrompt + ABSOLUTE_RULE,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API Error");
  const text = data.content?.find(b => b.type === "text")?.text;
  if (!text) throw new Error(`AI応答にテキストがありません (stop_reason: ${data.stop_reason})`);
  return text;
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
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
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
  const text = data.content?.find(b => b.type === "text")?.text;
  if (!text) throw new Error(`AI応答にテキストがありません (stop_reason: ${data.stop_reason})`);
  return text;
}

export {
  CORS_HEADERS, MAX_TEXT_LEN, validateInput,
  isValidUserId, isValidPlan, isAllowedRedirectUrl, ALLOWED_REDIRECT_ORIGINS,
  escapeHtml,
  checkRateLimit, checkSubscription,
  b64urlEncode, b64urlDecode, hmacHex, timingSafeEqual,
  jsonResponse, htmlResponse,
  callClaude, callClaudeVision,
};
