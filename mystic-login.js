// ============================================
// とむMYSTIC — mystic-login.js（マジックリンク認証版）
// フロント=github.io / API=workers.dev のクロスサイト構成のため、
// HttpOnly Cookie ではなく sessionId を localStorage に保持し
// Authorization: Bearer で伝送する。
// ============================================

const WORKER_URL = "https://mystic-system-worker.inverted-triangle-leef.workers.dev";

const MysticAuth = {
  SESSION_KEY: "mystic_session",
  SUBSCRIPTION_KEY: "mystic_subscription",

  getSession() {
    return localStorage.getItem(this.SESSION_KEY);
  },

  isLoggedIn() {
    return !!this.getSession();
  },

  isSubscribed() {
    return localStorage.getItem(this.SUBSCRIPTION_KEY) === "active";
  },

  authHeaders(extra = {}) {
    const sid = this.getSession();
    return sid ? { ...extra, "Authorization": `Bearer ${sid}` } : { ...extra };
  },

  // /auth/verify からのリダイレクト着地：#mystic_sid=... を取り込む
  captureSessionFromUrl() {
    const m = location.hash.match(/[#&]mystic_sid=([^&]+)/);
    if (!m) return false;
    const sid = decodeURIComponent(m[1]);
    localStorage.setItem(this.SESSION_KEY, sid);
    history.replaceState({}, "", location.pathname + location.search);
    return true;
  },

  // マジックリンクの送信を要求（この時点ではまだログインしていない）
  async requestMagicLink(email) {
    if (!email || !email.includes("@")) {
      throw new Error("有効なメールアドレスを入力してください");
    }
    const res = await fetch(`${WORKER_URL}/auth/request-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        redirect: location.href.split("#")[0],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "メールの送信に失敗しました");
    return true;
  },

  // サーバーでセッションを検証し、サブスク状態を取得・キャッシュ
  async refreshMe() {
    const sid = this.getSession();
    if (!sid) return { loggedIn: false, subscribed: false };
    let res;
    try {
      res = await fetch(`${WORKER_URL}/auth/me`, { headers: this.authHeaders() });
    } catch {
      return { loggedIn: true, subscribed: this.isSubscribed() };
    }
    if (res.status === 401) {
      this.logout();
      return { loggedIn: false, subscribed: false };
    }
    const data = await res.json().catch(() => ({}));
    const subscribed = data.subscribed === true;
    localStorage.setItem(this.SUBSCRIPTION_KEY, subscribed ? "active" : "inactive");
    return { loggedIn: true, subscribed, email: data.email };
  },

  async logout() {
    const sid = this.getSession();
    if (sid) {
      try {
        await fetch(`${WORKER_URL}/auth/logout`, { method: "POST", headers: this.authHeaders() });
      } catch { /* ignore */ }
    }
    localStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem(this.SUBSCRIPTION_KEY);
  },

  // Stripe Checkoutページへリダイレクト
  async startCheckout() {
    if (!this.isLoggedIn()) throw new Error("ログインが必要です");
    const res = await fetch(`${WORKER_URL}/stripe/checkout`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        successUrl: `${location.origin}${location.pathname}?checkout=success`,
        cancelUrl:  `${location.origin}${location.pathname}?checkout=cancel`,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || "決済ページの取得に失敗しました");
    location.href = data.url;
  },

  // 毎朝の占いメール設定を取得
  async getMailPref() {
    if (!this.isLoggedIn()) throw new Error("ログインが必要です");
    const res = await fetch(`${WORKER_URL}/mail-pref`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "設定の取得に失敗しました");
    return data.pref;
  },

  // 毎朝の占いメール設定を保存
  async saveMailPref(pref) {
    if (!this.isLoggedIn()) throw new Error("ログインが必要です");
    const res = await fetch(`${WORKER_URL}/mail-pref`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(pref),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "設定の保存に失敗しました");
    return data.pref;
  },

  // 各アプリからAI APIを呼ぶ共通関数
  async callApi(endpoint, body) {
    if (!this.isLoggedIn()) throw new Error("ログインが必要です");

    // /mystic/star-reading → action: "star-reading"
    const action = endpoint.replace(/^\/mystic\//, "");

    const res = await fetch(`${WORKER_URL}/api/mystic`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ action, ...body }),
    });

    if (res.status === 401) {
      this.logout();
      throw new Error("セッションの有効期限が切れました。再度ログインしてください。");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "APIエラーが発生しました");
    return data;
  },
};

// ============================================
// ログインUI（メールアドレス入力 → マジックリンク送信）
// ============================================

function renderLoginModal() {
  if (document.getElementById("mystic-login-modal")) return;

  const modal = document.createElement("div");
  modal.id = "mystic-login-modal";
  modal.innerHTML = `
    <div class="mystic-modal-overlay">
      <div class="mystic-modal-box">
        <div class="mystic-modal-star">✦</div>
        <h2 class="mystic-modal-title">とむMYSTIC</h2>
        <p class="mystic-modal-subtitle">星の導きへ、メールアドレスでログイン</p>
        <input
          id="mystic-email-input"
          type="email"
          placeholder="your@email.com"
          class="mystic-modal-input"
          autocomplete="email"
        />
        <button id="mystic-login-btn" class="mystic-modal-btn">
          ログインリンクを送る
        </button>
        <p id="mystic-login-error" class="mystic-modal-error"></p>
        <p class="mystic-modal-note">
          ※ ご入力のアドレスにログイン用リンクをお送りします
        </p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("mystic-login-btn").addEventListener("click", handleLoginClick);
  document.getElementById("mystic-email-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLoginClick();
  });
}

async function handleLoginClick() {
  const email = document.getElementById("mystic-email-input").value.trim();
  const errorEl = document.getElementById("mystic-login-error");
  const btn = document.getElementById("mystic-login-btn");

  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "送信中...";

  try {
    await MysticAuth.requestMagicLink(email);
    showMagicLinkSent(email);
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = "ログインリンクを送る";
  }
}

function showMagicLinkSent(email) {
  const box = document.querySelector("#mystic-login-modal .mystic-modal-box");
  if (!box) return;
  box.innerHTML = `
    <div class="mystic-modal-star">✉</div>
    <h2 class="mystic-modal-title">メールを確認してください</h2>
    <p class="mystic-modal-subtitle">${email} にログインリンクを送信しました。</p>
    <p class="mystic-modal-note">
      メール内のボタンから15分以内にログインしてください。<br/>
      届かない場合は迷惑メールフォルダもご確認ください。
    </p>
  `;
}

// ============================================
// サブスクリプションUI（Stripe連携）
// ============================================

function renderSubscriptionModal() {
  if (document.getElementById("mystic-sub-modal")) return;

  const modal = document.createElement("div");
  modal.id = "mystic-sub-modal";
  modal.innerHTML = `
    <div class="mystic-modal-overlay">
      <div class="mystic-modal-box">
        <div class="mystic-modal-star">☽</div>
        <h2 class="mystic-modal-title">サブスクリプション</h2>
        <p class="mystic-modal-subtitle">月額 ¥780 で全30アプリにフルアクセス</p>
        <ul class="mystic-plan-list">
          <li>✦ 星読み・タロット・数秘術</li>
          <li>✦ 守護星・魂の相性診断</li>
          <li>✦ 前世リーディング・夢解読</li>
          <li>✦ 月のジャーナル・宇宙のお告げ</li>
          <li>✦ 手相占い（画像AI解析）</li>
        </ul>
        <div class="mystic-price-badge">月額 ¥780（税込）</div>
        <button id="mystic-subscribe-btn" class="mystic-modal-btn">
          今すぐ始める ✦
        </button>
        <p id="mystic-sub-error" class="mystic-modal-error"></p>
        <p class="mystic-modal-note">Stripeの安全な決済ページへ移動します</p>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  document.getElementById("mystic-subscribe-btn").addEventListener("click", async () => {
    const btn = document.getElementById("mystic-subscribe-btn");
    const errEl = document.getElementById("mystic-sub-error");
    btn.disabled = true;
    btn.textContent = "決済ページへ移動中...";
    errEl.textContent = "";

    try {
      await MysticAuth.startCheckout();
      // startCheckout内でlocation.hrefが変わるのでここには到達しない
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = "今すぐ始める ✦";
    }
  });
}

// ============================================
// Checkout完了後の処理（URLパラメータ確認）
// ============================================

async function handleCheckoutReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get("checkout");
  if (!status) return false;

  // URLからパラメータを除去
  history.replaceState({}, "", location.pathname);

  if (status === "success") {
    // Webhookの処理を待つため少し待機してから再確認
    await new Promise((r) => setTimeout(r, 2000));
    const me = await MysticAuth.refreshMe();
    if (me.subscribed) {
      onLoginSuccess();
      return true;
    }
    // まだWebhookが来ていない場合のメッセージ
    showToast("決済を確認中です。少し経ってから再度ページを開いてください。");
    return true;
  }

  if (status === "cancel") {
    showToast("決済がキャンセルされました。");
    renderSubscriptionModal();
    return true;
  }

  return false;
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.style.cssText = `
    position:fixed; bottom:2rem; left:50%; transform:translateX(-50%);
    background:#2d1b4e; color:#e8d5b7; padding:.8rem 1.5rem;
    border-radius:8px; border:1px solid #7c4dff; font-size:.9rem;
    z-index:9999; box-shadow:0 4px 20px rgba(124,77,255,.3);
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function onLoginSuccess() {
  if (typeof window.onMysticLogin === "function") {
    window.onMysticLogin();
  } else {
    location.reload();
  }
  // 各アプリの #birthdate に保存済み生年月日を自動セット
  const el = document.getElementById("birthdate");
  if (el) {
    const val = sessionStorage.getItem("mystic_birthdate_temp") || localStorage.getItem("mystic_birthdate");
    if (val) el.value = val;
    // アプリ内で変更した場合はセッション中のみ一時保存
    el.addEventListener("change", () => {
      sessionStorage.setItem("mystic_birthdate_temp", el.value);
    });
  }
}

// ============================================
// ページ読み込み時の認証チェック
// ============================================

document.addEventListener("DOMContentLoaded", async () => {
  // /auth/verify からの着地：#mystic_sid を取り込む
  MysticAuth.captureSessionFromUrl();

  // Checkout戻り判定（successまたはcancel）
  if (MysticAuth.isLoggedIn()) {
    const handled = await handleCheckoutReturn();
    if (handled) return;
  }

  if (!MysticAuth.isLoggedIn()) {
    renderLoginModal();
    return;
  }

  // セッションをサーバーで検証し、サブスク状態を取得
  const me = await MysticAuth.refreshMe();
  if (!me.loggedIn) {
    renderLoginModal();
    return;
  }

  // index.html: ログイン済みならサブスク確認なしでアプリ一覧を表示
  if (window.MYSTIC_IS_INDEX) {
    onLoginSuccess();
    return;
  }

  // 各アプリ: サブスク確認してから表示
  if (!me.subscribed) {
    renderSubscriptionModal();
  } else {
    onLoginSuccess();
  }
});
