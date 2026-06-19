# ============================================================
# とむMYSTIC Worker — PowerShellデプロイスクリプト
# 使用前に CF_API_TOKEN と KV_NAMESPACE_ID を設定してください
#   $env:CF_API_TOKEN    = "your_token"
#   $env:KV_NAMESPACE_ID = "your_kv_namespace_id"
# ============================================================

$ErrorActionPreference = 'Stop'

$CF_ACCOUNT_ID  = "b6815ad2ee3097cc0f9e79b8536776b9"
$CF_WORKER_NAME = "tomu-mystic-worker"
$WORKER_FILE    = "tomu-mystic-worker.js"
$KV_NAMESPACE_ID = "5e1c00cba16d46119b2123dc4dd23322"

# 必須: Cloudflare API Token（Workers Script Edit権限）
if (-not $env:CF_API_TOKEN) {
    throw "CF_API_TOKEN が未設定です。`$env:CF_API_TOKEN = '...' で設定してください"
}

Write-Host "▶ デプロイ開始: $CF_WORKER_NAME"
Write-Host "  ファイル  : $WORKER_FILE"
Write-Host "  アカウント: $CF_ACCOUNT_ID"

# メタデータ（バインディング設定）
$metadata = @{
    main_module        = $WORKER_FILE
    bindings           = @(
        @{
            type         = "kv_namespace"
            name         = "MYSTIC_SUBSCRIPTIONS"
            namespace_id = $KV_NAMESPACE_ID
        }
    )
    compatibility_date = "2024-01-01"
} | ConvertTo-Json -Depth 5 -Compress

$workerScript = Get-Content -Path $WORKER_FILE -Raw -Encoding UTF8

# multipart/form-data を手動構築
$boundary = [System.Guid]::NewGuid().ToString("N")

$metadataBytes  = [System.Text.Encoding]::UTF8.GetBytes($metadata)
$workerBytes    = [System.Text.Encoding]::UTF8.GetBytes($workerScript)

$bodyParts = [System.Collections.Generic.List[byte[]]]::new()

# -- metadata part
$metaHeader = "--$boundary`r`nContent-Disposition: form-data; name=`"metadata`"`r`nContent-Type: application/json`r`n`r`n"
$bodyParts.Add([System.Text.Encoding]::UTF8.GetBytes($metaHeader))
$bodyParts.Add($metadataBytes)
$bodyParts.Add([System.Text.Encoding]::UTF8.GetBytes("`r`n"))

# -- worker script part
$scriptHeader = "--$boundary`r`nContent-Disposition: form-data; name=`"$WORKER_FILE`"; filename=`"$WORKER_FILE`"`r`nContent-Type: application/javascript+module`r`n`r`n"
$bodyParts.Add([System.Text.Encoding]::UTF8.GetBytes($scriptHeader))
$bodyParts.Add($workerBytes)
$bodyParts.Add([System.Text.Encoding]::UTF8.GetBytes("`r`n"))

# -- closing boundary
$bodyParts.Add([System.Text.Encoding]::UTF8.GetBytes("--$boundary--`r`n"))

# バイト列を結合
$totalLength = ($bodyParts | Measure-Object -Property Length -Sum).Sum
$body = [byte[]]::new($totalLength)
$offset = 0
foreach ($part in $bodyParts) {
    [System.Buffer]::BlockCopy($part, 0, $body, $offset, $part.Length)
    $offset += $part.Length
}

$url = "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/$CF_WORKER_NAME"

try {
    $response = Invoke-WebRequest `
        -Uri $url `
        -Method PUT `
        -Headers @{ Authorization = "Bearer $env:CF_API_TOKEN" } `
        -ContentType "multipart/form-data; boundary=$boundary" `
        -Body $body

    $statusCode = $response.StatusCode
    $responseJson = $response.Content | ConvertFrom-Json

    if ($statusCode -eq 200) {
        Write-Host "✅ デプロイ成功 (HTTP $statusCode)"
    } else {
        Write-Host "❌ デプロイ失敗 (HTTP $statusCode)"
        $response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10
        exit 1
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    Write-Host "❌ デプロイ失敗 (HTTP $statusCode)"
    $errorBody = $_.ErrorDetails.Message
    if ($errorBody) {
        try { $errorBody | ConvertFrom-Json | ConvertTo-Json -Depth 10 } catch { Write-Host $errorBody }
    } else {
        Write-Host $_.Exception.Message
    }
    exit 1
}

Write-Host ""
Write-Host "Worker URL:"
Write-Host "  https://$CF_WORKER_NAME.inverted-triangle-leef.workers.dev"
Write-Host ""
Write-Host "MCPエンドポイント:"
Write-Host "  POST https://$CF_WORKER_NAME.inverted-triangle-leef.workers.dev/mcp"
