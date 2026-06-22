# READINGS テーブル集約・整理 — 実装記録（2026-06-23）

## 結論
占い履歴を **D1 集約テーブル `readings`（1占い=1行に正規化）に統合**した。
旧構成（KV `history:<userId>` のユーザー別 JSON 配列）からは「読み取り時バックフィル」で
**無損失移行**し、既存 API（GET/DELETE /history・保存フロー）は形状・挙動を維持する。

## 現状調査（移行前）
- D1 はこの Worker に未バインドだった（KV `MYSTIC_SUBSCRIPTIONS` と Queue のみ）。
- `READINGS` は DB ではなくコード上の占い種別ディスパッチ表（refactor `ab4badc` で集約済み）。
- 占い履歴データは KV `history:<userId>`（新しい順・最大30件・TTLなし）に格納。
- 本番(REMOTE) KV スナップショット: `snapshots/kv-snapshot-remote-2026-06-23.json`（全9キー＋値）。
  - 実履歴: `history:aW52…+963@gmail.com`（star-reading 2件）。

## 実装した統合
1. **D1 データベース** `tomu-mystic-db`（binding `MYSTIC_DB`, id `e28dad11-…`）を新規作成。
   - 既存の別プロジェクト `shrines-db` には触れない。
2. **スキーマ** `migrations/0001_create_readings.sql`:
   `readings(id, user_id, action, result, extra(JSON), created_at)` ＋ `(user_id, created_at DESC, id DESC)` index。
3. **Worker クエリを新構成へ刷新**（`getHistory`/`saveHistory`/`handleHistory`）:
   - D1 をプライマリに。保存は INSERT＋30件超過の自動トリム。
   - 取得・削除は D1 を新しい順に参照（DELETE は対象行の id で実行）。
   - **未移行ユーザーは KV から読み取り時に D1 へバックフィル**（`d1Backfill`, batch INSERT）。KV は削除せず保持＝無損失。
   - D1 未バインド/障害時は **KV へ自動フォールバック**（既存フロー非破壊）。
   - GET レスポンス形状 `{action, result, createdAt, extra}` は旧構成と完全互換。

## 検証
- ローカル D1: 挿入・新しい順取得・index 削除・30件トリムの SQL を検証。
- 本番 D1（実セッションで GET /history 実行）:
  - 実ユーザーの履歴2件が KV→D1 へバックフィル（D1 BEFORE 0行 → AFTER 2行, 時系列順）。
  - レスポンスは旧構成と同形状で 200。
  - 2回目 GET は D1 から配信、件数2・**重複なし**（冪等）。KV は無傷。

## 安全性
- データ損失なし（KV を移行元として保持、バックフィルは batch・冪等運用）。
- 既存 API の破壊的変更なし（形状維持＋フォールバック）。
- 本番デプロイ済み（Version `14b0e23e`）。一括バックフィルは行わず、アクセス時に遅延移行。
