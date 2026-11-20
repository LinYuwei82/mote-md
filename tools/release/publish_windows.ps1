# Mote · Windows 在线更新发布（OSS 清单 + 绿色包 zip，更新清单 Schema v2）
#
# 输入：packaging/package_windows_native.ps1 产出的 dist\Mote-Windows.zip
# 动作：门禁校验 → 生成 Ed25519 签名的 manifest.json（v2）→ 上传 OSS → 线上校验
#
# 与 macOS 的 publish_macos.sh 对齐：
#   macOS   appcast.xml（Sparkle 验签）+ manifest.json（v2）→ .dmg
#   Windows 没有签名/安装器机制，只发 manifest.json（v2）→ 绿色包 zip
# 客户端只读 platforms.windows：artifacts.portable 为默认更新包，
# artifacts.setup 为安装版，避免把 .dmg 当成 Windows 安装包。
#
# 目录约定（v2 命名）：
#   oss://<bucket>/mote/mote-<version>-win64-portable.zip   长缓存 immutable
#   oss://<bucket>/mote/updates/<channel>/manifest.json     60 秒缓存
# 对外地址：
#   https://dl.xiaotu.online/mote/updates/stable/manifest.json   ← 客户端读取
#
# 依赖：python + oss2（python -m pip install oss2），凭据用环境变量或凭据文件
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1
#   powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1 -SkipUpload
#   powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1 -ZipPath dist\x.zip
#   powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1 -Build 202611190930
#   powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1 -Rollout 10
#   powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1 `
#       -Mandatory -MandatoryReason SECURITY -MandatoryDeadline 2026-12-01T00:00:00Z
#
# -Build 必须等于编译时的 -DMOTE_BUILD；省略时从 build-native-ninja\CMakeCache.txt 读取，
# 读不到直接失败（不再退回当前时间：清单比安装包新会让客户端反复提示同一版本）。

param(
    [string]$ZipPath = "",
    [string]$SetupPath = "",
    [ValidateSet("stable", "beta")][string]$Channel = "stable",
    [string]$CdnDomain = "https://dl.xiaotu.online",
    [string]$ProductDir = "mote",
    [string]$MinOs = "10.0",
    [string]$Build = "",
    [string]$EnvFile = "",
    [ValidateRange(1, 100)][int]$Rollout = 100,
    [switch]$Mandatory,
    [ValidateSet("SECURITY", "PROTOCOL", "REGULATORY", "MIN_SUPPORTED")][string]$MandatoryReason = "",
    [string]$MandatoryDeadline = "",
    [switch]$SkipUpload
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Fail([string]$message) {
    Write-Host "[失败] $message"
    exit 1
}

# 灰度 / 强制更新参数互斥与格式校验（与 publish_macos.sh 同一口径）
if ($Mandatory -and -not $MandatoryReason) {
    Fail "强制更新必须用 -MandatoryReason 指定 SECURITY/PROTOCOL/REGULATORY/MIN_SUPPORTED 之一"
}
if (-not $Mandatory -and ($MandatoryReason -or $MandatoryDeadline)) {
    Fail "-MandatoryReason / -MandatoryDeadline 只在 -Mandatory 时有效"
}
if ($MandatoryDeadline -and $MandatoryDeadline -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$') {
    Fail "-MandatoryDeadline 必须是 ISO 8601 UTC（如 2026-12-01T00:00:00Z）"
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
        if ($name -match '^export\s+(.+)$') { $name = $Matches[1].Trim() }
        $value = $pair[1].Trim().Trim('"').Trim("'")
        if ($name) { Set-Item -Path "Env:$name" -Value $value }
    }
}

if (-not $EnvFile) { $EnvFile = Join-Path $env:USERPROFILE ".config\xiaotu-updates\.env" }
Import-EnvFile $EnvFile

Write-Host "===== Mote 发布 · Windows ====="

Write-Host "[1/6] 读取版本与产物"
$versionLine = Get-Content -LiteralPath (Join-Path $root "VERSION.txt") | Select-Object -First 1
if (-not $versionLine) { Fail "无法从 VERSION.txt 读取版本号" }
$Version = $versionLine.Trim()

# v2 清单 windows 平台必须带 build（客户端同版本比对构建号）。
# 必须与二进制里的 MOTE_BUILD 一致：取编译时写进 CMakeCache 的值。取不到就直接
# 失败并要求显式传 -Build——退回当前时间会让清单比安装包「更新」，客户端每次检测
# 都判定有新版本、装完仍是同一个包，形成无限更新循环，且很难在线上看出来。
if ([string]::IsNullOrWhiteSpace($Build)) {
    $cachePath = Join-Path $root "build-native-ninja\CMakeCache.txt"
    if (Test-Path -LiteralPath $cachePath) {
        $cacheText = Get-Content -LiteralPath $cachePath -Raw
        $match = [regex]::Match($cacheText, 'MOTE_BUILD:[A-Z]+=(\d+)')
        if ($match.Success) { $Build = $match.Groups[1].Value }
    }
    if ([string]::IsNullOrWhiteSpace($Build)) {
        Fail "未能确定编译时的 MOTE_BUILD：CMakeCache 里没有该变量。请用 -Build <构建号> 显式传入，值必须与 -DMOTE_BUILD 一致"
    }
}
if ($Build -notmatch '^\d{4,}$') { Fail "非法构建号：$Build（应为纯数字，如 202611180930）" }

# 二次验证：和 CMakeCache 里的 MOTE_BUILD 一致（防止 shell 手动传 -Build 与编译值不同步）
$cachePath = Join-Path $root "build-native-ninja\CMakeCache.txt"
if (Test-Path -LiteralPath $cachePath) {
    $cacheText = Get-Content -LiteralPath $cachePath -Raw
    $cachedMatch = [regex]::Match($cacheText, 'MOTE_BUILD:[A-Z]+=(\d+)')
    if ($cachedMatch.Success) {
        $cachedBuild = $cachedMatch.Groups[1].Value
        if ($cachedBuild -ne $Build) {
            Fail "-Build $Build 与编译时 CMakeCache MOTE_BUILD=$cachedBuild 不一致；请保持同步（或清理 build 目录重编）"
        }
        Write-Host "构建号：$Build（CMakeCache 一致 ✓）"
    } else {
        Write-Host "构建号：$Build（CMakeCache 未找到 MOTE_BUILD，跳过二次验证）"
    }
} else {
    Write-Host "构建号：$Build（无 CMakeCache，跳过二次验证）"
}

# 签名种子：环境变量优先（CI），其次本地种子文件
$signKeyPath = $null
if (-not [string]::IsNullOrWhiteSpace($env:MOTE_UPDATE_SIGNING_KEY)) {
    $signKeyPath = Join-Path $env:TEMP ("mote-manifest-key-" + [guid]::NewGuid().ToString("N") + ".b64")
    [IO.File]::WriteAllText($signKeyPath, $env:MOTE_UPDATE_SIGNING_KEY.Trim())
} else {
    $signKeyPath = Join-Path $env:USERPROFILE ".config\mote-updates\ed25519_seed.b64"
}
if (-not (Test-Path -LiteralPath $signKeyPath)) {
    Fail "v2 清单签名种子不存在：$signKeyPath（或设置环境变量 MOTE_UPDATE_SIGNING_KEY）"
}

if (-not $ZipPath) { $ZipPath = Join-Path $root "dist\Mote-Windows.zip" }
if (-not (Test-Path $ZipPath)) {
    Fail "zip 不存在：$ZipPath（先跑 packaging\package_windows_native.ps1）"
}
$ZipFull = (Resolve-Path $ZipPath).Path

# 安装包可选：存在就一起发（dist\Mote-Setup-<version>.exe，由 build_installer.ps1 生成）
if (-not $SetupPath) { $SetupPath = Join-Path $root "dist\Mote-Setup-$Version.exe" }
$SetupFull = ""
if (Test-Path $SetupPath) {
    $SetupFull = (Resolve-Path $SetupPath).Path
    # Inno 写出的 FileVersion 会补空格（"0.3.7               "），先 Trim 再比
    $setupVersion = (Get-Item $SetupFull).VersionInfo.FileVersion.Trim()
    if ($setupVersion -ne $Version) {
        Fail "安装包版本 $setupVersion 与 VERSION $Version 不一致，先重新打包"
    }
}

Write-Host "[2/6] 门禁：zip 内容与版本必须自洽"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($ZipFull)
try {
    # Compress-Archive 写的是反斜杠分隔，统一成正斜杠再比对
    $names = $archive.Entries | ForEach-Object { $_.FullName -replace '\\', '/' }
    foreach ($required in @("Mote.exe", "WebView2Loader.dll", "web/editor.html",
                            "fonts/JetBrainsMono-Light.ttf")) {
        $hit = $names | Where-Object { $_.EndsWith($required, [StringComparison]::OrdinalIgnoreCase) }
        if (-not $hit) { Fail "zip 缺少 $required" }
    }
    $qt = $names | Where-Object { $_ -match "(^|/)Qt6.*\.dll$" -or $_ -match "(^|/)platforms/qwindows\.dll$" }
    if ($qt) { Fail ("zip 里出现 Qt 产物：" + ($qt -join ", ")) }

    # 从 zip 里取 Mote.exe 的版本号：以产物为准，避免目录里留着旧 exe 时误判
    $entry = $archive.Entries | Where-Object {
        $_.FullName.EndsWith("Mote.exe", [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1
    $tempExe = Join-Path $env:TEMP ("mote-publish-" + [guid]::NewGuid().ToString("N") + ".exe")
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tempExe)
    try {
        $exeVersion = (Get-Item $tempExe).VersionInfo.FileVersion
    } finally {
        Remove-Item $tempExe -Force -ErrorAction SilentlyContinue
    }
} finally {
    $archive.Dispose()
}

Write-Host "  VERSION           : $Version"
Write-Host "  zip 内 exe 版本   : $exeVersion"
if ($exeVersion -ne $Version) {
    Fail "zip 内 exe 版本 $exeVersion 与 VERSION $Version 不一致，先重新构建打包"
}

$Size = (Get-Item $ZipFull).Length
$Sha256 = (Get-FileHash $ZipFull -Algorithm SHA256).Hash.ToLower()
$PublishedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$SetupSize = 0
$SetupSha256 = ""
$SetupUrl = ""
if ($SetupFull) {
    $SetupSize = (Get-Item $SetupFull).Length
    $SetupSha256 = (Get-FileHash $SetupFull -Algorithm SHA256).Hash.ToLower()
}

# 远端文件名固定按 v2 命名：<product>-<version>-<os>-<arch>-<type>.<ext>
# （本地产物名不变，index.html 与客户端清单都以远端 v2 名为准）
$RemoteName = "mote-$Version-win64-portable.zip"
$V2SetupName = "mote-$Version-win64-setup.exe"
$DownloadUrl = "$CdnDomain/$ProductDir/$RemoteName"
$SetupUrl = "$CdnDomain/$ProductDir/$V2SetupName"
$ManifestKey = "$ProductDir/updates/$Channel/manifest.json"
$ManifestUrl = "$CdnDomain/$ManifestKey"

Write-Host ""
Write-Host "  zip          : $ZipFull"
Write-Host "  大小         : $Size 字节"
Write-Host "  SHA256       : $Sha256"
Write-Host "  下载地址     : $DownloadUrl"
Write-Host "  manifest.json: $ManifestUrl"
if ($SetupFull) {
    Write-Host "  setup        : $SetupUrl（$SetupSize 字节）"
    Write-Host "  setup SHA256 : $SetupSha256"
} else {
    Write-Host "  setup        : 未找到 $SetupPath，跳过安装包"
}

Write-Host ""
Write-Host "[3/6] 生成 manifest.json（v2，Ed25519 签名）"
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { Fail "找不到 python（manifest_v2 / guard 需要）" }
$manifestPath = Join-Path $root "dist\manifest.json"
# platforms.windows.artifacts：portable 为默认更新包，setup 为安装版；
# notes_url 只在本地存在 docs\release-notes-<版本>.html 时才写，并随本次发布一起上传；
# 缺页时不写该字段，客户端就不会出现「查看完整更新说明…」的死链。
$NotesFile = Join-Path $root "docs\release-notes-$Version.html"
$NotesUrl = ""
$NotesKey = ""
if (Test-Path -LiteralPath $NotesFile) {
    $NotesKey = "$ProductDir/release-notes-$Version.html"
    $NotesUrl = "$CdnDomain/$NotesKey"
} else {
    Write-Host "  提示：未找到 docs\release-notes-$Version.html，清单不写 notes_url"
}
$manifestV2Args = @(
    "generate", "--product", $ProductDir, "--channel", $Channel,
    "--platform", "windows", "--version", $Version, "--build", $Build,
    "--min-os", $MinOs, "--key-id", "2026-11",
    "--artifact", "portable=$ZipFull",
    "--rollout", "$Rollout",
    "--key", $signKeyPath, "--out", $manifestPath
)
if ($Mandatory) {
    $manifestV2Args += @("--mandatory", "--mandatory-reason", $MandatoryReason)
    if ($MandatoryDeadline) { $manifestV2Args += @("--mandatory-deadline", $MandatoryDeadline) }
    Write-Host "  更新策略：灰度 $Rollout% · 强制更新（$MandatoryReason$(if ($MandatoryDeadline) { "，截止 $MandatoryDeadline" })）"
} else {
    Write-Host "  更新策略：灰度 $Rollout% · 非强制"
}
if ($SetupFull) { $manifestV2Args += @("--artifact", "setup=$SetupFull") }
if ($NotesUrl) { $manifestV2Args += @("--notes-url", $NotesUrl) }
# 另一平台段可能已在线上：先取线上清单，--prev 合并后整体重签，避免覆盖另一平台段
if (-not (Test-Path -LiteralPath $manifestPath)) {
    try { Invoke-WebRequest -Uri $ManifestUrl -OutFile $manifestPath -UseBasicParsing } catch {
        Remove-Item -LiteralPath $manifestPath -ErrorAction SilentlyContinue
    }
}
if (Test-Path -LiteralPath $manifestPath) { $manifestV2Args += @("--prev", $manifestPath) }
& $python (Join-Path $root "tools\release\manifest_v2.py") @manifestV2Args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path -LiteralPath $manifestPath)) { Fail "没有找到清单：$manifestPath" }
$pubHexLine = & $python (Join-Path $root "tools\release\manifest_v2.py") pubkey --key $signKeyPath
$PubHex = ($pubHexLine -join "") -replace '.*：', ''

Write-Host ""
Write-Host "[3.5/6] 发布门禁（guard，v2）"
$guardArgs = @(
    "--product", $ProductDir, "--kind", "win", "--channel", $Channel,
    # 注：guard.py 已移除 --schema 参数（强制 v2），不再需要传
    "--manifest", $manifestPath, "--pub-hex", $PubHex, "--build", $Build
)
if ($SetupFull) {
    $guardArgs += @("--file", $SetupFull, "--name", $V2SetupName,
                    "--zip", $ZipFull, "--zip-name", $RemoteName)
} else {
    $guardArgs += @("--file", $ZipFull, "--name", $RemoteName)
}
if ($SkipUpload) { $guardArgs += "--offline" }
& $python (Join-Path $root "tools\release\guard.py") preflight @guardArgs
if ($LASTEXITCODE -ne 0) { Fail "guard preflight 未通过（v2 命名/版本/覆盖/内嵌地址/签名）" }

Write-Host ""
if ($SkipUpload) {
    Write-Host "[4/6] [SkipUpload] 跳过上传"
} else {
    Write-Host "[4/6] 上传"
    foreach ($name in @("OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_REGION")) {
        if (-not (Get-Item -Path "Env:$name" -ErrorAction SilentlyContinue)) {
            Fail "缺少环境变量 $name（或写进 $EnvFile）"
        }
    }
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) { Fail "找不到 python（上传依赖 oss2）" }

    $uploadScript = Join-Path $env:TEMP "mote-publish-upload.py"
    $pythonCode = @'
import os, oss2
bucket, region = os.environ["OSS_BUCKET"], os.environ["OSS_REGION"]
endpoint = f"https://oss-{region}.aliyuncs.com"
bkt = oss2.Bucket(oss2.Auth(os.environ["OSS_ACCESS_KEY_ID"],
                            os.environ["OSS_ACCESS_KEY_SECRET"]), endpoint, bucket)
bkt.put_object_from_file(os.environ["UPLOAD_ZIP_KEY"], os.environ["UPLOAD_ZIP_PATH"],
                         headers={"Cache-Control": "public, max-age=31536000, immutable",
                                  "Content-Type": "application/zip"})
bkt.put_object_from_file(os.environ["UPLOAD_MANIFEST_KEY"], os.environ["UPLOAD_MANIFEST_PATH"],
                         headers={"Cache-Control": "no-cache, max-age=60",
                                  "Content-Type": "application/json"})
setup_key = os.environ.get("UPLOAD_SETUP_KEY")
if setup_key:
    bkt.put_object_from_file(setup_key, os.environ["UPLOAD_SETUP_PATH"],
                             headers={"Cache-Control": "public, max-age=31536000, immutable",
                                      "Content-Type": "application/octet-stream"})
notes_key = os.environ.get("UPLOAD_NOTES_KEY")
if notes_key:
    bkt.put_object_from_file(notes_key, os.environ["UPLOAD_NOTES_PATH"],
                             headers={"Cache-Control": "public, max-age=3600",
                                      "Content-Type": "text/html; charset=utf-8"})
print("  zip          -> " + os.environ["UPLOAD_ZIP_KEY"])
print("  manifest.json-> " + os.environ["UPLOAD_MANIFEST_KEY"])
if setup_key:
    print("  setup        -> " + setup_key)
if notes_key:
    print("  release-notes-> " + notes_key)
'@
    [IO.File]::WriteAllText($uploadScript, $pythonCode, (New-Object System.Text.UTF8Encoding($false)))

    $env:UPLOAD_ZIP_PATH = $ZipFull
    $env:UPLOAD_ZIP_KEY = "$ProductDir/$RemoteName"
    $env:UPLOAD_MANIFEST_PATH = $manifestPath
    $env:UPLOAD_MANIFEST_KEY = $ManifestKey
    if ($SetupFull) {
        $env:UPLOAD_SETUP_PATH = $SetupFull
        $env:UPLOAD_SETUP_KEY = "$ProductDir/$V2SetupName"
    } else {
        Remove-Item Env:UPLOAD_SETUP_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:UPLOAD_SETUP_KEY -ErrorAction SilentlyContinue
    }
    if ($NotesKey) {
        $env:UPLOAD_NOTES_PATH = $NotesFile
        $env:UPLOAD_NOTES_KEY = $NotesKey
    } else {
        Remove-Item Env:UPLOAD_NOTES_PATH -ErrorAction SilentlyContinue
        Remove-Item Env:UPLOAD_NOTES_KEY -ErrorAction SilentlyContinue
    }
    & $python $uploadScript
    if ($LASTEXITCODE -ne 0) { Fail "上传失败（python 退出码 $LASTEXITCODE）" }
}

Write-Host ""
Write-Host "[5/6] 线上校验"
if ($SkipUpload) {
    Write-Host "  （跳过）本地清单：$manifestPath"
} else {
    $ProgressPreference = "SilentlyContinue"
    try {
        $head = Invoke-WebRequest -Uri $DownloadUrl -Method Head -UseBasicParsing -TimeoutSec 30
        if ($head.StatusCode -eq 200 -and [int64]$head.Headers["Content-Length"] -eq $Size) {
            Write-Host "  ✓ zip 可下载，长度与本地一致（$Size 字节）"
        } else {
            Write-Host "  ✗ zip 校验异常：HTTP $($head.StatusCode) 长度 $($head.Headers['Content-Length'])"
        }
    } catch {
        Write-Host "  ✗ zip 不可访问：$($_.Exception.Message)（检查 CDN 缓存或 bucket 权限）"
    }

    try {
        $live = Invoke-WebRequest -Uri $ManifestUrl -UseBasicParsing -TimeoutSec 30
        # PowerShell 5.1 的 ConvertTo-Json 会在冒号后补两个空格，正则不能写死一个空格
        $shaPattern = [regex]::Escape($Sha256)
        $versionPattern = '"version":\s*"' + [regex]::Escape($Version) + '"'
        $setupPattern = '"setup":\s*\{[\s\S]*?"url":\s*"' + [regex]::Escape($SetupUrl) + '"'
        if ($live.StatusCode -eq 200 -and $live.Content -match $shaPattern -and
            $live.Content -match $versionPattern -and
            (-not $SetupFull -or $live.Content -match $setupPattern)) {
            Write-Host "  ✓ manifest.json 版本与 SHA256 均与产物一致"
        } else {
            Write-Host "  ✗ manifest.json 内容异常：$($live.Content)"
        }
    } catch {
        Write-Host "  ✗ manifest.json 不可访问：$($_.Exception.Message)"
    }

    if ($SetupFull) {
        try {
            $head = Invoke-WebRequest -Uri $SetupUrl -Method Head -UseBasicParsing -TimeoutSec 30
            if ($head.StatusCode -eq 200 -and [int64]$head.Headers["Content-Length"] -eq $SetupSize) {
                Write-Host "  ✓ 安装包可下载，长度与本地一致（$SetupSize 字节）"
            } else {
                Write-Host "  ✗ 安装包校验异常：HTTP $($head.StatusCode) 长度 $($head.Headers['Content-Length'])"
            }
        } catch {
            Write-Host "  ✗ 安装包不可访问：$($_.Exception.Message)"
        }
    }
}

Write-Host ""
if (-not $SkipUpload) {
    Write-Host ""
    Write-Host "[5.5/6] 线上门禁（guard）"
    & $python (Join-Path $root "tools\release\guard.py") verify-live @guardArgs
    if ($LASTEXITCODE -ne 0) { Fail "guard verify-live 未通过（清单/大小/SHA/Content-Type）" }
}

Write-Host "[6/6] 本次发布摘要（下载页由 site.js 读取 manifest.json 自动同步，无需手改 index.html）"
Write-Host ("  版本   : v{0}" -f $Version)
Write-Host ("  大小   : {0:N0} 字节（约 {1:N1} MB）" -f $Size, ($Size / 1MB))
Write-Host ("  SHA256 : {0}" -f $Sha256)
Write-Host ("  下载   : {0}" -f $DownloadUrl)
if ($SetupFull) {
    Write-Host ("  setup  : {0:N0} 字节（约 {1:N1} MB）" -f $SetupSize, ($SetupSize / 1MB))
    Write-Host ("  setup SHA256 : {0}" -f $SetupSha256)
    Write-Host ("  setup 下载   : {0}" -f $SetupUrl)
}
Write-Host "================ 完成 ================"
