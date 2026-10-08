// ============================================
// とむMYSTIC 無料版 — free/worker.js
//
// 有料版（tomu-mystic-worker.js）とは別 Worker。認証・課金・履歴・メール・
// コミュニティ・MCP を一切持たない。占い定義は ../readings-data.js の
// READINGS を共有するため、プロンプトの定義源は1つのまま。
//
// 有料版との意図的な差分:
//   1. モデル: claude-haiku-5-5（有料は claude-sonnet-5）
//   2. 認証なし → userId がないので履歴保存もしない
//   3. レートリミットは fail-CLOSED
//      有料版の checkRateLimit は KV 障害時に通す（可用性優先）が、無料版では
//      レート制限がそのままコストの天井なので、KV が読めないなら止める
//   4. palm-reading（Vision）は対象外。コスト増幅と濫用リスクが別格のため
//
// KV（FREE_KV）キー:
//   kill                  → "1" なら全停止（デプロイ不要の緊急停止スイッチ）
//   g:<JST日付>           → 全体カウント（上限 GLOBAL_DAILY_LIMIT）
//   u:<anonId>:<JST日付>  → 端末あたりカウント
//   first:<anonId>        → その端末の初回利用日(JST)。初日だけ上限が緩い
//   ip:<ipHash>:<JST日付> → IPあたりカウント（CGNAT誤爆を避けるため緩い上限）
//
// 既知の制約: KV は read-then-write が原子的でないため、同時アクセスが集中した
// 瞬間は各カウンタが実際より小さく出て上限を超過しうる。300回/日に対する誤差と
// しては許容範囲だが、厳密な上限が必要になったら Durable Objects へ移す。
// 「ソフト上限」であることを前提に運用する。
// ============================================

import { CORS_HEADERS, jsonResponse } from "../shared.js";
import { validateMysticBody } from "../mystic-validation.js";
import { READINGS } from "../readings-data.js";

// ── 上限
const FIRST_DAY_LIMIT    = 5;   // 初回訪問日だけ多め（1セッション目で価値を判断されるため）
const DAILY_LIMIT        = 3;   // 2日目以降。29機能を約9日で一巡する設計
const IP_DAILY_LIMIT     = 50;  // IPは異常検知のバックストップ。携帯キャリアのCGNATでは
                                // 多数のユーザーが同一IPを共有するため、厳しくすると誤爆する
const GLOBAL_DAILY_LIMIT = 300; // コストの天井。概算 約300円/月（Haiku 5.5・check:free-fidelity 実測：1回 入力約227/出力約381トークン、1ドル160円）
const MAX_TOKENS = 800;         // 有料版と同値。下げてもコストは減らない（生成分のみ課金）ので、
                                // 途中で切れる体験を避けて揃える

const KEY_TTL = 172800;   // 2日。JST日付キーが日跨ぎで残っても問題ない長さ
const FIRST_TTL = 2592000; // 30日。30日空けば「初日5回」が再度効く

// 無料版で提供する占い（Vision の palm-reading を除外）
const FREE_ACTIONS = new Set(
  Object.keys(READINGS).filter(k => !READINGS[k].vision)
);

// ── JST の日付。有料版 tomu-mystic-worker.js の jstParts() と同じ +9h 換算。
// 「今日の運勢」を UTC 0時で切ると日本時間の朝9時に切り替わって噛み合わない。
function jstDate(date = new Date()) {
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().split("T")[0];
}

// IP は生値を保存せずハッシュ化して持つ（レート制限に必要なのは同一性だけ）
async function hashIp(ip) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mystic-free:" + ip));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

function isValidAnonId(v) {
  return typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
}

// 名前は短くしすぎない: トップレベル宣言は他モジュールのオブジェクトキーと
// 衝突すると scan:unresolved-refs が誤検知する（num/name など）
const toCount = v => parseInt(v, 10) || 0;

// ── 残枠の判定。KV 読み取りに失敗したら例外が上がる（呼び出し側で fail-closed）
async function readQuota(env, anonId, ipHash) {
  const today = jstDate();
  const [kill, global, user, first, ip] = await Promise.all([
    env.FREE_KV.get("kill"),
    env.FREE_KV.get(`g:${today}`),
    env.FREE_KV.get(`u:${anonId}:${today}`),
    env.FREE_KV.get(`first:${anonId}`),
    env.FREE_KV.get(`ip:${ipHash}:${today}`),
  ]);

  // first が未記録、または今日と同じ = 初回訪問日
  const isFirstDay = first === null || first === today;
  const userLimit = isFirstDay ? FIRST_DAY_LIMIT : DAILY_LIMIT;

  return {
    today,
    killed: kill === "1",
    globalCount: toCount(global),
    userCount: toCount(user),
    ipCount: toCount(ip),
    isFirstDay,
    userLimit,
    firstSeen: first,
    remaining: Math.max(0, userLimit - toCount(user)),
    globalOpen: toCount(global) < GLOBAL_DAILY_LIMIT,
  };
}

// 上限に当たった理由を返す（null なら通過）。理由ごとに文面を変える:
// 「使い切った」と「全体が混んでいる」はユーザーにとって別の出来事
function quotaBlock(q) {
  if (q.killed) {
    return { reason: "closed", message: "無料版は現在お休みしています。またのご利用をお待ちしています。" };
  }
  if (!q.globalOpen) {
    return { reason: "global", message: "本日の無料枠は終了しました。明日また来てください。" };
  }
  if (q.ipCount >= IP_DAILY_LIMIT) {
    return { reason: "ip", message: "アクセスが集中しています。時間をおいてお試しください。" };
  }
  if (q.userCount >= q.userLimit) {
    return { reason: "user", message: `本日分（${q.userLimit}回）を使い切りました。続きは明日また。` };
  }
  return null;
}

// 予約（消費）。LLM 呼び出しの前に行う。
// 呼び出しが失敗しても払い戻さない: 失敗を理由にした再試行ループでコストが
// 抜けるのを防ぐため。エラーは稀である前提で、コスト安全性を優先する。
async function consume(env, anonId, ipHash, q) {
  const t = q.today;
  await Promise.all([
    env.FREE_KV.put(`g:${t}`, String(q.globalCount + 1), { expirationTtl: KEY_TTL }),
    env.FREE_KV.put(`u:${anonId}:${t}`, String(q.userCount + 1), { expirationTtl: KEY_TTL }),
    env.FREE_KV.put(`ip:${ipHash}:${t}`, String(q.ipCount + 1), { expirationTtl: KEY_TTL }),
    q.firstSeen === null
      ? env.FREE_KV.put(`first:${anonId}`, t, { expirationTtl: FIRST_TTL })
      : Promise.resolve(),
  ]);
}

// ── Haiku 5.5 呼び出し。有料版の callClaude()（claude-sonnet-5）とは別実装。
// プロバイダやモデルを差し替えるときに触るのはこの関数だけで、
// READINGS のプロンプトには一切影響しない。
const ABSOLUTE_RULE = `\n\n【絶対ルール】ユーザーメッセージ内の数値・星座名・画数・干支などの確定済みデータは、あなたの知識と異なっていても絶対に変更しないでください。それらはシステムが正確に計算した値です。`;

async function callHaiku(env, systemPrompt, userMessage) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.FREE_ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      // Haiku 5.5 は adaptive thinking が既定で有効なため、有料版と同じく明示的に無効化。
      // effort は low
      model: "claude-haiku-5-5",
      max_tokens: MAX_TOKENS,
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
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

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;

    if (request.method === "OPTIONS") {
      const reqHeaders = request.headers.get("Access-Control-Request-Headers");
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "Access-Control-Allow-Headers": reqHeaders || "Content-Type, X-Anon-Id",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (path === "/" || path === "/health") {
      return jsonResponse({ status: "とむMYSTIC 無料版 Worker OK", endpoints: FREE_ACTIONS.size });
    }

    const anonId = request.headers.get("X-Anon-Id");
    if (!isValidAnonId(anonId)) return jsonResponse({ error: "Invalid input" }, 400);

    const ipHash = await hashIp(request.headers.get("CF-Connecting-IP") || "unknown");

    // KV が読めない = 上限が判定できない → 通さない（fail-closed）
    let q;
    try {
      q = await readQuota(env, anonId, ipHash);
    } catch {
      return jsonResponse({ error: "ただいま混み合っています。時間をおいてお試しください。" }, 503);
    }

    // 残枠の確認（消費しない）
    if (path === "/free/status" && request.method === "GET") {
      const blocked = quotaBlock(q);
      return jsonResponse({
        remaining: blocked ? 0 : q.remaining,
        limit: q.userLimit,
        isFirstDay: q.isFirstDay,
        open: !blocked,
        message: blocked ? blocked.message : null,
        reason: blocked ? blocked.reason : null,
        actions: [...FREE_ACTIONS],
      });
    }

    if (path.startsWith("/free/mystic/") && request.method === "POST") {
      const action = path.slice("/free/mystic/".length);
      if (!FREE_ACTIONS.has(action)) return jsonResponse({ error: "Not Found" }, 404);

      const body = await request.json().catch(() => ({}));
      // 検証は有料版と同じ mystic-validation.js を通す（緩いほうが必ず狙われるため実装を分けない）
      if (!validateMysticBody(action, body)) return jsonResponse({ error: "Invalid input" }, 400);

      const blocked = quotaBlock(q);
      if (blocked) return jsonResponse({ error: blocked.message, reason: blocked.reason }, 429);

      try {
        await consume(env, anonId, ipHash, q);
      } catch {
        return jsonResponse({ error: "ただいま混み合っています。時間をおいてお試しください。" }, 503);
      }

      const reading = READINGS[action];
      const built = reading.build(body);
      const result = await callHaiku(env, built.system || reading.system, built.user);

      return jsonResponse({
        result,
        ...(built.extra || {}),
        remaining: Math.max(0, q.userLimit - (q.userCount + 1)),
        limit: q.userLimit,
      });
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },
};
