# tomu-mystic-worker デプロイスクリプト（wrangler版）
#
# 使い方: .\deploy_wrangler.ps1 -Token "your_cf_api_token"
#         または $env:CLOUDFLARE_API_TOKEN を設定して .\deploy_wrangler.ps1 を実行

param(
    [string]$Token = $env:CLOUDFLARE_API_TOKEN
)

if (-not $Token) {
    Write-Error "CLOUDFLARE_API_TOKEN が未設定です。-Token パラメータで渡すか、環境変数を設定してください。"
    exit 1
}

$env:CLOUDFLARE_API_TOKEN = $Token

Write-Host "Deploying tomu-mystic-worker with wrangler ..."

npx wrangler deploy

if ($LASTEXITCODE -eq 0) {
    Write-Host "Deploy successful!" -ForegroundColor Green
    Write-Host "Worker: https://tomu-mystic-worker.inverted-triangle-leef.workers.dev"
    Write-Host "MCP:    https://tomu-mystic-worker.inverted-triangle-leef.workers.dev/mcp"
} else {
    Write-Host "Deploy failed." -ForegroundColor Red
    exit 1
}
