# とむMYSTIC

AI占いサービス。Cloudflare Worker＋静的フロントエンド（GitHub Pages）で構成。

Worker はモジュール分割されており、`tomu-mystic-worker.js`（エントリ）から
`shared.js` / `auth.js` / `stripe.js` / `readings-data.js` / `kanji-strokes.js` / `mcp.js`
を import し、デプロイ時に wrangler 内蔵の esbuild が1ファイルにバンドルする。
占いのプロンプト定義は `readings-data.js` の READINGS テーブルが唯一の定義源（MCPも参照）。

- Worker: `https://tomu-mystic-worker.inverted-triangle-leef.workers.dev`
- 構成の詳細（KV / D1 スキーマ）は `tomu-mystic-worker.js` 冒頭のコメントを参照

## 未解決参照スキャン（モジュール分割時は必ず実行）

```bash
npm run scan:unresolved-refs
```

`wrangler.toml` の `main` から相対 import を再帰的に辿り、**「別モジュールの
トップレベル宣言を import せずに参照している」箇所**を検出する。検出ゼロなら exit 0、
1件以上なら exit 1（CI・pre-commit フックで使える）。

> **なぜビルドだけでは不十分か**: wrangler 内蔵の esbuild は未解決識別子を
> グローバル参照として扱うため、export/import が漏れていても
> `wrangler deploy --dry-run` を含めビルドは**警告ゼロで通る**。破損は実行時の
> ReferenceError として本番で初めて顕在化し、広い `try/catch` がそれを握り潰すと
> 設定ミスや外部サービス起因のエラーに化けて調査を誤らせる。
>
> 実例: `6e556ce` のモジュール分割で 5 シンボルが未解決のまま本番稼働し、
> `ALLOWED_REDIRECT_ORIGINS` の欠落でサブスク決済導線が約6週間停止した
> （`catch` が ReferenceError を飲み、400 `Invalid redirect URL` に化けていた）。
> 併せて認証結果ページが 500、毎朝メールが不送信になっていた。修正は `2fa2fae`。
> このスキャナを `6e556ce` に対して実行すると 5 件すべてを検出する。

新しくモジュールを切り出した場合、import で繋がっていれば**スキャナ側の変更は不要**
（対象はグラフから自動導出される）。

## デプロイ

デプロイは **wrangler 一本**（`wrangler.toml` が唯一の設定ソース）。

```powershell
npx wrangler deploy
# または
.\deploy_wrangler.ps1 -Token "your_cf_api_token"
```

> **注意**: 旧 `deploy.sh` / `deploy.ps1`（Cloudflare raw API への PUT）は廃止済み。
> raw API の PUT は `keep_bindings` / `keep_secrets` を指定しない限り既存の
> Secrets・バインディングを消してしまう事故リスクがあるため、復活させないこと。
> （関連: worker のリネームも新規 worker 扱いとなり Secrets が全消失する）

### デプロイ前後のシークレット確認手順

`wrangler deploy` は Secrets を保持するが、設定ドリフト検知のためデプロイ前後で一覧を確認する。

```powershell
npx wrangler secret list
```

以下のシークレットが揃っていること（`wrangler.toml` に書かず `wrangler secret put` で登録）:

| シークレット | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API（占い生成・Vision） |
| `AUTH_SECRET` | マジックリンク署名 |
| `RESEND_API_KEY` | メール送信（Resend） |
| `STRIPE_SECRET_KEY` | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook 署名検証 |
| `MYSTIC_PRICE_ID` | Stripe 価格ID |
| `MCP_TOKEN` | MCP エンドポイント認証 |
| `ADMIN_TOKEN` | 管理系エンドポイント認証 |

バインディング（KV `MYSTIC_SUBSCRIPTIONS` / D1 `MYSTIC_DB` / Queue `MAIL_QUEUE`）は
`wrangler.toml` に定義済みで、デプロイのたびに同内容が適用される。
デプロイ後は `npx wrangler deployments status` やダッシュボードで確認できる。

### Observability

`wrangler.toml` の `[observability] enabled = true` により Workers Logs（invocation logs）が有効。
Cloudflare Dashboard > Workers & Pages > tomu-mystic-worker > Logs で参照。

## コミュニティ機能について

コミュニティ（みんなの占い結果）は **独立した worker ではない**。

- API（`/community/feed|post|like` など）: `tomu-mystic-worker.js` 内に実装（本 `wrangler.toml` でデプロイされる）
- フロント: `community/index.html`（静的ページ、GitHub Pages 配信）

そのため community 用の個別 wrangler.toml / デプロイ手順は存在しない。


## 無料版（tomu-mystic-free-worker）

29種類の占いを登録不要で試せるお試し版。**同じリポジトリの別 Worker** として動く。

- リポジトリを分けない理由: READINGS（30占いのプロンプト定義）・`apps/*.html`・
  `mystic.css` を丸ごと二重管理することになり、有料版のプロンプト修正が
  無料版に届かなくなる。無料版は有料版の広告塔なので、体験版と本製品が
  別物になるのが一番まずい。
- Worker を分ける理由: 無料版は未認証で叩かれるため、濫用（CPU・レート・
  API コスト）が課金ユーザーに波及しないよう隔離する。Stripe / 認証 /
  D1 / Queues のバインディングも Secrets も持たせない。

### 有料版との意図的な差分

| | 有料版 | 無料版 |
|---|---|---|
| モデル | `claude-sonnet-5` | `claude-haiku-5-5` |
| 認証 | マジックリンク + サブスク | なし（localStorage の匿名ID） |
| 占い数 | 30 | 29（Vision の `palm-reading` は除外） |
| 回数 | 20回/時 | 初日5回・以降3回/日（JST 0時リセット） |
| 全体上限 | なし | 300回/日（コスト天井・Haiku 5.5 で要再見積もり（4.5 より大幅に安い見込み）） |
| KV 障害時 | 通す（fail-open・可用性優先） | **止める（fail-closed）** |
| 履歴・メール・コミュニティ・MCP | あり | なし |

fail-open / fail-closed が逆なのは意図的。有料版はレート制限が「濫用対策」だが、
無料版ではレート制限が**そのままコストの天井**なので、判定できないなら通さない。

### 構成

```
free/worker.js            無料版 Worker（../readings-data.js の READINGS を共有）
free/mystic-free.js       mystic-login.js の差し替え（同じ外部インターフェース）
free/wrangler.free.toml   無料版のデプロイ設定
free/index.html           生成物（触らない）
free/apps/*.html          生成物（触らない）
mystic-validation.js      入力検証。有料版と無料版の両方が import する
```

`mystic-validation.js` は有料版 `tomu-mystic-worker.js` から切り出したもの。
無料版は認証を持たない分、入力検証がコスト増幅攻撃への最初の防御線になるため、
実装を分けない（緩いほうが必ず狙われる）。

### コマンド

```bash
npm run build:free                # apps/ と index.html から free/ を生成
npm run test:free                 # 上限・fail-closed・入力検証の動作確認（API を叩かない）
npm run scan:unresolved-refs      # 有料版の未解決参照スキャン
npm run scan:unresolved-refs:free # 無料版の未解決参照スキャン
npm run dev:free                  # ローカル起動
```

`free/apps/` と `free/index.html` は `tools/build-free-pages.mjs` の生成物。
手で編集すると次回の生成で消える。占いを増やしたら `npm run build:free` を実行する。

### モデルを変えるときは必ず確定値チェックを通す

```bash
ANTHROPIC_API_KEY=xxx npm run check:free-fidelity
```

このアーキテクチャは「星座・画数・干支・キン番号を JS で確定計算し、AI には
変えるなと命じる」設計（`ABSOLUTE_RULE`）で、`apps/*.html` は計算値を
`calc-display` として AI の文章のすぐ隣に表示する。安いモデルがこのルールを
守れないと、画面上で一目で分かる形で矛盾する。**コストだけを見てモデルを
落とすと、この破綻を見落とす。**

`check:free-fidelity` は29件について「確定値が出力に残っているか」と
「同じカテゴリの別の値にすり替わっていないか」を検査する（実際に API を叩くため課金される）。

### デプロイ（完了条件外・とむが実行）

```powershell
npx wrangler secret put FREE_ANTHROPIC_API_KEY -c free/wrangler.free.toml
npx wrangler deploy -c free/wrangler.free.toml
```

`FREE_ANTHROPIC_API_KEY` は**無料版専用に新規発行したキー**を使う。
有料版と同じキーだと請求が混ざり、300回/日の超過を検知できない。

KV namespace（`FREE_KV`）は 2026-09-06 に作成済みで、id は
`free/wrangler.free.toml` に反映してある。作り直す必要はない。
再作成が要る場合のみ `npx wrangler kv namespace create FREE_KV -c free/wrangler.free.toml`。

> 無料版のデプロイに合わせて**有料版の再デプロイも要る**。
> `mystic-validation.js` の切り出しとプライバシーポリシー修正で
> `tomu-mystic-worker.js` 側も変わっているため。

### 緊急停止

KV に `kill` = `"1"` を置くと全リクエストが止まる（デプロイ不要・即時）。

```powershell
npx wrangler kv key put --binding=FREE_KV kill 1 -c free/wrangler.free.toml --remote
```

「無料版は予告なく終了する場合があります」と告知したうえで、このスイッチで切る運用。
