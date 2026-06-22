-- 占い結果履歴の集約テーブル
-- 旧構成: KV の history:<userId> にユーザーごとの JSON 配列（最大30件）として分散保存。
-- 新構成: 1占い=1行に正規化した単一テーブル readings に集約する。
-- 既存データは Worker 側の「読み取り時バックフィル」で KV から本テーブルへ無損失移行される。

CREATE TABLE IF NOT EXISTS readings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  result     TEXT NOT NULL,
  extra      TEXT NOT NULL DEFAULT '{}',  -- JSON文字列（占い固有の確定値など）
  created_at TEXT NOT NULL                -- ISO8601 UTC
);

-- ユーザー別・新しい順取得を高速化
CREATE INDEX IF NOT EXISTS idx_readings_user_created
  ON readings (user_id, created_at DESC, id DESC);
