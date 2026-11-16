# 下载页（站点首页）发布：source of truth 是仓库里的 site/index.html
#
# 注意：本文件保存为 UTF-8 with BOM。PowerShell 5.1 会把无 BOM 的 .ps1 按 ANSI 读取，
#       中文字符串会直接解析失败，改动后请确认 BOM 还在。
#
# 发布内容：
#   index.html  → OSS 桶根目录（https://dl.xiaotu.online/index.html）
#
# 依赖：python + oss2（python -m pip install oss2），凭据用环境变量或凭据文件
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File packaging\publish_site.ps1
#   powershell -ExecutionPolicy Bypass -File packaging\publish_site.ps1 -SkipUpload
#   powershell -ExecutionPolicy Bypass -File packaging\publish_site.ps1 -SkipLinkCheck

param(
    [string]$PagePath = "",
    [string]$ObjectKey = "index.html",
    [string]$CdnDomain = "https://dl.xiaotu.online",
    [string]$EnvFile = "",
    [switch]$SkipUpload,
    [switch]$SkipLinkCheck
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

function Fail([string]$message) {
    Write-Host "[失败] $message"
    exit 1
}

# 凭据：环境变量优先，其次读 %USERPROFILE%\.config\xiaotu-updates\.env（与 macOS 同路径风格）
function Import-EnvFile([string]$path) {
    if (-not (Test-Path $path)) { return }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $pair = $line -split "=", 2
        if ($pair.Count -ne 2) { return }
        $name = $pair[0].Trim()
        $value = $pair[1].Trim().Trim('"').Trim("'")
        if ($name) { Set-Item -Path "Env:$name" -Value $value }
    }
}

if (-not $EnvFile) { $EnvFile = Join-Path $env:USERPROFILE ".config\xiaotu-updates\.env" }
Import-EnvFile $EnvFile

Write-Host "===== 下载页发布 ====="

# ---------- [1/4] 读取页面 ----------
Write-Host "[1/4] 读取页面"
if (-not $PagePath) { $PagePath = Join-Path $root "site\index.html" }
if (-not (Test-Path $PagePath)) { Fail "页面不存在：$PagePath" }
$PageFull = (Resolve-Path $PagePath).Path
$bytes = [IO.File]::ReadAllBytes($PageFull)
if ($bytes.Length -eq 0) { Fail "页面为空：$PageFull" }
if ($bytes.Length -gt 2 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    Fail "页面带 UTF-8 BOM，浏览器会多出一个不可见字符，请另存为 UTF-8 无 BOM"
}
$pageText = [Text.Encoding]::UTF8.GetString($bytes)
if ($pageText -notmatch "dl\.xiaotu\.online") { Fail "页面里没有 dl.xiaotu.online 链接，疑似拿错文件" }
Write-Host "    文件：$PageFull"
Write-Host "    大小：$([string]::Format('{0:N0}', $bytes.Length)) 字节"

$stale = ([regex]::Matches($pageText, "待上传")).Count
if ($stale -gt 0) {
    Write-Host "    提示：页面仍有 $stale 处「待上传」，确认是有意保留再发布" -ForegroundColor Yellow
}

# ---------- [2/4] 链接门禁 ----------
Write-Host "[2/4] 校验页面里的下载链接"
$links = [regex]::Matches($pageText, 'href="(https://dl\.xiaotu\.online/[^"]+)"') |
    ForEach-Object { $_.Groups[1].Value } |
    Where-Object { $_ -notmatch "/$ObjectKey$" } |
    Sort-Object -Unique

if ($SkipLinkCheck) {
    Write-Host "    已跳过（-SkipLinkCheck），共 $($links.Count) 个链接"
} else {
    $bad = @()
    foreach ($link in $links) {
        try {
            $response = Invoke-WebRequest -Uri $link -Method Head -UseBasicParsing -MaximumRedirection 3
            if ($response.StatusCode -ne 200) { $bad += "$link → HTTP $($response.StatusCode)" }
        } catch {
            $bad += "$link → $($_.Exception.Message)"
        }
    }
    if ($bad.Count -gt 0) {
        foreach ($item in $bad) { Write-Host "    ✗ $item" -ForegroundColor Red }
        Fail "有 $($bad.Count) 个下载链接不可用，先修页面再发布"
    }
    Write-Host "    ✓ $($links.Count) 个下载链接均返回 200"
}

# ---------- [3/4] 上传 ----------
Write-Host "[3/4] 上传到 $CdnDomain/$ObjectKey"
if ($SkipUpload) {
    Write-Host "    已跳过（-SkipUpload）"
} else {
    foreach ($name in @("OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_REGION")) {
        if (-not (Get-Item "Env:$name" -ErrorAction SilentlyContinue)) {
            Fail "缺少环境变量 $name（或写进 $EnvFile）"
        }
    }
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { Fail "找不到 python（上传依赖 oss2）" }

    $uploadScript = Join-Path $env:TEMP "mote-site-upload.py"
    $pythonCode = @'
import os, sys, oss2
path, key = sys.argv[1], sys.argv[2]
bucket_name, region = os.environ["OSS_BUCKET"], os.environ["OSS_REGION"]
endpoint = "https://oss-%s.aliyuncs.com" % region
bkt = oss2.Bucket(oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"],
                            os.environ["OSS_ACCESS_KEY_SECRET"]), endpoint, bucket_name)
bkt.put_object_from_file(key, path, headers={
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, max-age=60",
})
print("uploaded %s -> %s" % (path, key))
'@
    [IO.File]::WriteAllText($uploadScript, $pythonCode, (New-Object System.Text.UTF8Encoding($false)))
    & $python $uploadScript $PageFull $ObjectKey
    if ($LASTEXITCODE -ne 0) { Fail "上传失败（python 退出码 $LASTEXITCODE）" }
    Remove-Item $uploadScript -ErrorAction SilentlyContinue
}

# ---------- [4/4] 线上校验 ----------
Write-Host "[4/4] 线上校验"
if ($SkipUpload) {
    Write-Host "    已跳过（本次未上传）"
} else {
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $live = (Invoke-WebRequest -Uri "$CdnDomain/$ObjectKey`?t=$stamp" -UseBasicParsing).Content
    if ($live -ne $pageText) {
        Fail "线上内容与本地不一致（可能被 CDN 缓存，稍后重试）"
    }
    Write-Host "    ✓ 线上内容与本地一致"
}

Write-Host "================ 完成 ================"
Write-Host "    页面：$CdnDomain/$ObjectKey"
