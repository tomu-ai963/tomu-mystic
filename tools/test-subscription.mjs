// ============================================
// 有料版の契約まわりのローカル動作確認 — tools/test-subscription.mjs
//
// KV をインメモリで、外部 fetch（Resend など）をスタブで差し替えて検証する。
// 外部 API は叩かないので課金されない。
//
//   npm run test:subscription
//
// 確認するのは、決済サービスの申請前に用意した部分:
//   - /stripe/checkout が閉じていること（Stripe API を呼ばない）
//   - 法務ページ（利用規約・特商法・プライバシー）の配信と Stripe 表記の除去
//   - 契約状態の照会・解約の受付・解約済みユーザーの手動登録ガード
// ============================================

import worker from "../tomu-mystic-worker.js";

// ── インメモリ KV
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

// ── 外部 fetch のスタブ（送ったメールを記録する。failMail で Resend 障害を再現）
const sent = [];
let failMail = false;
const fetchCalls = [];
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push(String(url));
  if (String(url).startsWith("https://api.resend.com/")) {
    if (failMail) return new Response("resend down", { status: 500 });
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "test" }), { status: 200 });
  }
  return new Response("unexpected fetch", { status: 599 });
};

const EMAIL = "user@example.com";
const USER_ID = btoa(EMAIL);
const SID = "sid-test";
const OTHER_SID = "sid-other";
const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

function makeEnv() {
  const kv = makeKv({
    [`session:${SID}`]: JSON.stringify({ userId: USER_ID, expiry: Date.now() + 3600_000 }),
    [`session:${OTHER_SID}`]: JSON.stringify({ userId: btoa("nosub@example.com"), expiry: Date.now() + 3600_000 }),
    [USER_ID]: JSON.stringify({ active: true, plan: "mystic", expires: future, createdAt: new Date().toISOString() }),
  });
  return { MYSTIC_SUBSCRIPTIONS: kv, RESEND_API_KEY: "test", ADMIN_TOKEN: "admin-test" };
}

async function call(env, path, { method = "GET", sid, body, headers = {} } = {}) {
  const h = { ...headers };
  if (sid) h.Authorization = `Bearer ${sid}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await worker.fetch(new Request(`https://w.test${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML */ }
  return { status: res.status, json, text };
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. Stripe Checkout は閉じている
{
  console.log("1. /stripe/checkout");
  const env = makeEnv();
  fetchCalls.length = 0;
  const r = await call(env, "/stripe/checkout", { method: "POST", sid: SID, body: { successUrl: "https://tomu-ai963.github.io/x", cancelUrl: "https://tomu-ai963.github.io/x" } });
  check("503 を返す", r.status === 503, `status=${r.status}`);
  check("Stripe API を呼ばない", !fetchCalls.some(u => u.includes("stripe.com")), fetchCalls.join(","));
}

// ── 2. 法務ページ
{
  console.log("2. 法務ページ");
  const env = makeEnv();
  const terms = await call(env, "/legal/terms");
  check("利用規約 200", terms.status === 200 && terms.text.includes("利用規約"), `status=${terms.status}`);
  check("利用規約に自動更新・解約・返金の条項", ["自動的に更新", "第6条（解約）", "第7条（返金）"].every(s => terms.text.includes(s)));
  const toku = await call(env, "/legal/tokushoho");
  check("特商法 200", toku.status === 200);
  check("特商法に追加項目", ["支払時期", "契約期間・自動更新", "解約方法", "解約後のご利用", "商品代金以外の必要料金", "動作環境"].every(s => toku.text.includes(s)));
  const priv = await call(env, "/legal/privacy");
  for (const [name, page] of [["利用規約", terms], ["特商法", toku], ["プライバシー", priv]]) {
    check(`${name}に Stripe の記載なし`, !page.text.includes("Stripe"));
  }
}

// ── 3. 契約状態の照会
{
  console.log("3. /subscription/status");
  const env = makeEnv();
  check("未認証は 401", (await call(env, "/subscription/status")).status === 401);
  const none = await call(env, "/subscription/status", { sid: OTHER_SID });
  check("未契約は subscribed:false", none.status === 200 && none.json.subscribed === false);
  const ok = await call(env, "/subscription/status", { sid: SID });
  check("契約中は subscribed:true・期限つき・解約なし",
    ok.json.subscribed === true && ok.json.expires === future && ok.json.cancelRequested === false, JSON.stringify(ok.json));
}

// ── 4. 解約の受付
{
  console.log("4. /subscription/cancel");
  const env = makeEnv();
  const kv = env.MYSTIC_SUBSCRIPTIONS;
  check("GET は 405", (await call(env, "/subscription/cancel", { sid: SID })).status === 405);
  check("未認証は 401", (await call(env, "/subscription/cancel", { method: "POST" })).status === 401);
  check("未契約は 400", (await call(env, "/subscription/cancel", { method: "POST", sid: OTHER_SID })).status === 400);

  sent.length = 0;
  const r = await call(env, "/subscription/cancel", { method: "POST", sid: SID });
  check("受付 200", r.status === 200 && r.json.success === true && r.json.expires === future, JSON.stringify(r.json));
  const sub = JSON.parse(kv.store.get(USER_ID));
  check("KV に解約の印・active は維持", sub.cancelRequested === true && !!sub.cancelRequestedAt && sub.active === true);
  check("cancel_req キーが入る", kv.store.has(`cancel_req:${USER_ID}`));
  check("本人と運営者に 1 通ずつ", sent.length === 2
    && sent.some(m => m.to[0] === EMAIL)
    && sent.some(m => m.to[0] === "Inverted.triangle.leef@gmail.com" && m.subject.includes(EMAIL)), JSON.stringify(sent.map(m => m.to)));

  const st = await call(env, "/subscription/status", { sid: SID });
  check("期限までは利用可・解約済み表示", st.json.subscribed === true && st.json.cancelRequested === true);

  sent.length = 0;
  const again = await call(env, "/subscription/cancel", { method: "POST", sid: SID });
  check("二重受付は alreadyRequested・メールなし", again.json.alreadyRequested === true && sent.length === 0);

  // 期限切れ後は未契約に戻る
  kv.store.set(USER_ID, JSON.stringify({ ...sub, expires: new Date(Date.now() - 1000).toISOString() }));
  const expired = await call(env, "/subscription/status", { sid: SID });
  check("期限切れ後は subscribed:false", expired.json.subscribed === false);
}

// ── 5. メール障害でも受付は成立する
{
  console.log("5. Resend 障害時");
  const env = makeEnv();
  failMail = true;
  const r = await call(env, "/subscription/cancel", { method: "POST", sid: SID });
  failMail = false;
  check("受付 200", r.status === 200 && r.json.success === true);
  check("KV に解約の印", JSON.parse(env.MYSTIC_SUBSCRIPTIONS.store.get(USER_ID)).cancelRequested === true);
}

// ── 6. 解約済みユーザーの手動登録ガード
{
  console.log("6. /subscription/register");
  const env = makeEnv();
  const kv = env.MYSTIC_SUBSCRIPTIONS;
  await call(env, "/subscription/cancel", { method: "POST", sid: SID });
  const admin = { "X-Admin-Token": "admin-test" };
  const blocked = await call(env, "/subscription/register", { method: "POST", headers: admin, body: { userId: USER_ID, plan: "mystic" } });
  check("解約済みは 409", blocked.status === 409, `status=${blocked.status}`);
  check("409 では KV を書き換えない", JSON.parse(kv.store.get(USER_ID)).cancelRequested === true);
  const re = await call(env, "/subscription/register", { method: "POST", headers: admin, body: { userId: USER_ID, plan: "mystic", resubscribe: true } });
  check("resubscribe:true なら 200", re.status === 200);
  check("再契約で解約の印と cancel_req が消える",
    JSON.parse(kv.store.get(USER_ID)).cancelRequested === undefined && !kv.store.has(`cancel_req:${USER_ID}`));
  const fresh = await call(env, "/subscription/register", { method: "POST", headers: admin, body: { userId: btoa("new@example.com"), plan: "mystic" } });
  check("未解約ユーザーは従来どおり 200", fresh.status === 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
