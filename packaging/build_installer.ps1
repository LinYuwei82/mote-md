# 构建 Windows 安装包（Inno Setup 6）
# 前置：先运行 packaging\package_windows.bat 生成 dist\Mote-Windows
# 用法：powershell -ExecutionPolicy Bypass -File packaging\build_installer.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$proFile = Join-Path $root "Mote.pro"

if (-not (Test-Path $proFile)) {
    throw "找不到 Mote.pro：$proFile"
}
$pro = Get-Content $proFile -Raw
if ($pro -notmatch '(?m)^\s*VERSION\s*=\s*([0-9]+(?:\.[0-9]+)+)') {
    throw "Mote.pro 中未找到 VERSION = x.y.z"
}
$version = $Matches[1]

$greenDir = Join-Path $root "dist\Mote-Windows"
if (-not (Test-Path (Join-Path $greenDir "Mote.exe"))) {
    throw "缺少绿色版目录 dist\Mote-Windows，请先运行 packaging\package_windows.bat"
}

$candidates = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
)
$iscc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    throw "未找到 ISCC.exe，请先安装 Inno Setup 6（winget install JRSoftware.InnoSetup）"
}

& $iscc "/DMyAppVersion=$version" (Join-Path $PSScriptRoot "mote.iss")
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup 编译失败（退出码 $LASTEXITCODE）"
}

$setup = Join-Path $root "dist\Mote-Setup-$version.exe"
if (-not (Test-Path $setup)) {
    throw "编译完成但未找到安装包：$setup"
}
$size = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host "安装包：$setup（$size MB）"
