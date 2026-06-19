#!/bin/bash
# ============================================================
# とむMYSTIC Worker — curlデプロイスクリプト
# 使用前に CF_API_TOKEN と KV_NAMESPACE_ID を設定してください
# ============================================================

set -e

CF_ACCOUNT_ID="b6815ad2ee3097cc0f9e79b8536776b9"
CF_WORKER_NAME="tomu-mystic-worker"
WORKER_FILE="tomu-mystic-worker.js"

# 必須: Cloudflare API Token（Workers Script Edit権限）
CF_API_TOKEN="${CF_API_TOKEN:?'CF_API_TOKEN が未設定です。export CF_API_TOKEN=... で設定してください'}"

# 必須: MYSTIC_SUBSCRIPTIONS KV Namespace ID
KV_NAMESPACE_ID="${KV_NAMESPACE_ID:?'KV_NAMESPACE_ID が未設定です。export KV_NAMESPACE_ID=... で設定してください'}"

echo "▶ デプロイ開始: ${CF_WORKER_NAME}"
echo "  ファイル : ${WORKER_FILE}"
echo "  アカウント: ${CF_ACCOUNT_ID}"

# メタデータ（バインディング設定）
METADATA=$(cat <<EOF
{
  "main_module": "${WORKER_FILE}",
  "bindings": [
    {
      "type": "kv_namespace",
      "name": "MYSTIC_SUBSCRIPTIONS",
      "namespace_id": "${KV_NAMESPACE_ID}"
    }
  ],
  "compatibility_date": "2024-01-01"
}
EOF
)

HTTP_STATUS=$(curl -s -o /tmp/cf_deploy_response.json -w "%{http_code}" \
  -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/${CF_WORKER_NAME}" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -F "metadata=${METADATA};type=application/json" \
  -F "${WORKER_FILE}=@${WORKER_FILE};type=application/javascript+module")

if [ "$HTTP_STATUS" = "200" ]; then
  echo "✅ デプロイ成功 (HTTP ${HTTP_STATUS})"
else
  echo "❌ デプロイ失敗 (HTTP ${HTTP_STATUS})"
  cat /tmp/cf_deploy_response.json | python3 -m json.tool 2>/dev/null || cat /tmp/cf_deploy_response.json
  exit 1
fi

echo ""
echo "Worker URL:"
echo "  https://${CF_WORKER_NAME}.$(jq -r '.result.id' /tmp/cf_deploy_response.json 2>/dev/null || echo 'YOUR_SUBDOMAIN').workers.dev"
echo ""
echo "MCPエンドポイント:"
echo "  POST https://${CF_WORKER_NAME}.YOUR_SUBDOMAIN.workers.dev/mcp"
