// ============================================
// 無料版フロントの生成 — tools/build-free-pages.mjs
//
// apps/*.html と index.html を「唯一の定義源」として free/ 以下を生成する。
// 無料版のためにページを手でコピーすると、有料版のUI修正が無料版に届かなくなる。
// 生成物（free/apps/ と free/index.html）は手で編集しないこと。
//
//   npm run build:free
//
// 変換内容:
//   1. script src の ../mystic-login.js → ../mystic-free.js（差し替えの本体）
//   2. ../mystic.css → ../../mystic.css（free/apps/ は1階層深いため）
//   3. palm-reading（Vision）は無料版の対象外なので除外
//   4. *-manifest.json を併せてコピーし、中の ../common/ を ../../common/ に直す
//   5. apps/sw.js を併せてコピー
//   6. プライバシーポリシーへのフッターを注入
//
// 4 と 5 は「free/apps/ が apps/ より1階層深い」ことの帰結で、2 と同じ問題。
// HTML の相対パスだけ直して JSON と sw.js を放置していたため、無料版では
// PWA アイコン29件と Service Worker がまとめて 404 になっていた。
// apps/ 配下に新しい種類のファイルを足すときは、ここも見ること。
// ============================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = join(ROOT, "apps");
const OUT = join(ROOT, "free", "apps");

// 無料版から外す占い（Vision はコスト増幅と濫用リスクが別格）
const EXCLUDED = new Set(["palm-reading"]);

// プライバシーポリシーは有料版 Worker が配信している（無料版 Worker は API 専用）。
const PRIVACY_URL = "https://mystic.tomu-ai.dev/legal/privacy";

// 無料版は登録不要でも匿名IDとIPハッシュを扱うので、どのページからでも
// ポリシーに到達できる必要がある。有料版の apps/*.html はフッターを持たず
// （導線はハブの index.html だけ）、無料版は個別ページに直接来られるため、
// ハブに1本置くだけでは届かない。生成時に全ページへ注入する。
const FREE_FOOTER = `<footer style="text-align:center;padding:1.4rem 1rem 2rem;font-size:.78rem;line-height:1.9;color:var(--muted)">
  <a href="${PRIVACY_URL}" target="_blank" rel="noopener" style="color:var(--muted);border-bottom:1px solid var(--border)">プライバシーポリシー</a>
</footer>
`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const pages = readdirSync(APPS).filter(f => f.endsWith(".html"));
let written = 0;
let manifests = 0;
let iconsFixed = 0;
const skipped = [];

for (const file of pages) {
  const id = file.replace(/\.html$/, "");
  if (EXCLUDED.has(id)) { skipped.push(id); continue; }

  const src = readFileSync(join(APPS, file), "utf8");
  if (!src.includes("../mystic-login.js")) {
    throw new Error(`${file}: ../mystic-login.js が見つかりません（構造が変わった可能性）`);
  }

  if (!src.includes("</body>")) {
    throw new Error(`${file}: </body> が見つかりません（フッターを注入できない）`);
  }

  const out = src
    .replaceAll("../mystic-login.js", "../mystic-free.js")
    .replaceAll("../mystic.css", "../../mystic.css")
    .replace("</body>", `${FREE_FOOTER}</body>`);

  writeFileSync(join(OUT, file), out);

  // マニフェストがあれば併せてコピー。アイコンの ../common/ は
  // free/apps/ から見ると1階層足りず、そのままだと 404 になる。
  const manifest = `${id}-manifest.json`;
  let manifestSrc = null;
  try {
    manifestSrc = readFileSync(join(APPS, manifest), "utf8");
  } catch { /* マニフェストが無いページは無視 */ }

  if (manifestSrc !== null) {
    writeFileSync(join(OUT, manifest), manifestSrc.replaceAll("../common/", "../../common/"));
    manifests++;
    if (manifestSrc.includes("../common/")) iconsFixed++;
  }

  written++;
}

// ── Service Worker。有料版は apps/sw.js を実体で持っており、各ページが
// 相対で register('sw.js') する。無料版でも同じ構造を保つためコピーする。
// 登録先をルートの /sw.js に向ける手もあるが、それだと1つの SW が有料版と
// 無料版の両方を支配することになるので、有料版と同じ形を複製するほうを採る。
// （SHELL の一部が別スコープで404になる件は sw.js 側が allSettled で織り込み済み）
const swSrc = join(APPS, "sw.js");
let sw;
try {
  sw = readFileSync(swSrc, "utf8");
} catch {
  throw new Error("apps/sw.js が見つかりません。各ページが register('sw.js') するため必須");
}
writeFileSync(join(OUT, "sw.js"), sw);

// ── free/index.html を index.html の hub-card 行から生成する。
// カード一覧を手書きすると、占いを増やしたときに無料版だけ古くなる。
const indexSrc = readFileSync(join(ROOT, "index.html"), "utf8");
const cards = indexSrc
  .split("\n")
  .map(l => l.trim())
  .filter(l => l.startsWith('<a href="apps/') && l.includes("hub-card"))
  .filter(l => ![...EXCLUDED].some(id => l.includes(`apps/${id}.html`)));

if (cards.length !== written) {
  throw new Error(`index.html のカード数(${cards.length})と生成ページ数(${written})が一致しません`);
}

const freeIndex = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>とむMYSTIC 無料版 — ${written}種類の占いを毎日お試し</title>
<meta name="description" content="とむMYSTICの占い${written}種類を無料でお試し。1日3回まで、登録不要ですぐ使えます。"/>
<link rel="stylesheet" href="../mystic.css"/>
<style>
  .mf-hero{text-align:center;padding:1.6rem 1rem .4rem}
  .mf-hero h1{font-size:1.25rem;margin:0 0 .5rem}
  .mf-hero p{font-size:.86rem;color:#b8a4ff;margin:0 auto;max-width:32rem;line-height:1.8}
  .mf-done{opacity:.45}
  .mf-foot{text-align:center;padding:1.6rem 1rem 2.4rem;font-size:.82rem;color:#b8a4ff;line-height:1.9}
  .mf-foot a{color:#e6dcff}
</style>
</head>
<body>
<header>
  <a href="./index.html" class="logo">✦ とむMYSTIC 無料版</a>
</header>
<main id="app">
  <div class="mf-hero">
    <h1>${written}種類の占いを、毎日すこしずつ</h1>
    <p>登録不要。1日3回まで（初日は5回）お試しいただけます。
       ぜんぶ試すには約9日かかります——明日もぜひ。</p>
  </div>
  <div class="hub-grid">
${cards.map(c => "    " + c).join("\n")}
  </div>
  <div class="mf-foot">
    無料版は予告なく終了する場合があります。<br>
    毎朝メール・履歴保存・回数無制限は
    <a href="https://tomu-ai963.github.io/tomu-mystic/">とむMYSTIC（有料版）</a>で。<br>
    <a href="${PRIVACY_URL}" target="_blank" rel="noopener">プライバシーポリシー</a>
  </div>
</main>
<script src="./mystic-free.js"></script>
<script>
// 試した占いを控えめに示す（進捗が見えないと「3回で止められた」体験になる）
document.addEventListener("DOMContentLoaded", () => {
  let tried = [];
  try { tried = JSON.parse(localStorage.getItem("mystic_free_tried") || "[]"); } catch {}
  if (!Array.isArray(tried)) return;
  for (const a of document.querySelectorAll('a[href^="apps/"]')) {
    const id = a.getAttribute("href").replace("apps/", "").replace(".html", "");
    if (tried.includes(id)) a.classList.add("mf-done");
  }
});
</script>
</body>
</html>
`;

writeFileSync(join(ROOT, "free", "index.html"), freeIndex);

console.log(`無料版フロント生成: ${written} ページ + index.html`);
console.log(`マニフェスト: ${manifests} 件（うちアイコンのパスを補正 ${iconsFixed} 件）+ sw.js`);
console.log(`除外: ${skipped.join(", ") || "なし"}`);
