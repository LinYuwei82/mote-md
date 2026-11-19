# 构建 Windows 安装包（Inno Setup 6）
# 前置：先运行 packaging\package_windows_native.ps1 生成 dist\Mote-Windows（原生外壳绿色版）
# 用法：powershell -ExecutionPolicy Bypass -File packaging\build_installer.ps1

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $root "VERSION.txt"

if (-not (Test-Path -LiteralPath $versionFile)) {
    throw "找不到 VERSION.txt：$versionFile"
}
$version = (Get-Content -LiteralPath $versionFile | Select-Object -First 1).Trim()
if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "VERSION.txt 的内容不是 x.y.z：$version"
}

$greenDir = Join-Path $root "dist\Mote-Windows"
if (-not (Test-Path $greenDir)) {
    throw "缺少绿色版目录 dist\Mote-Windows，请先运行 packaging\package_windows_native.ps1"
}

# 「装得上、跑不起来」是这里代价最高的错误：WebView2Loader 或页面资源缺任何一个，
# 安装包照样能生成、能安装，但双击后只会闪退或弹系统缺 DLL 对话框。
# 所以把运行必需的文件逐个断言，缺一项就在这里失败。
$requiredFiles = @(
    "Mote.exe",
    "WebView2Loader.dll",
    "web\editor.html",
    "fonts\JetBrainsMono-Light.ttf"
)
foreach ($rel in $requiredFiles) {
    $full = Join-Path $greenDir $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw "绿色版缺少运行必需文件：$rel（$full）。请重新运行 packaging\package_windows_native.ps1"
    }
}

# 原生外壳不应携带 Qt 运行时；混进来通常是用了旧的打包目录
$qt = Get-ChildItem -LiteralPath $greenDir -Filter "Qt6*.dll" -File -ErrorAction SilentlyContinue
if ($qt -or (Test-Path (Join-Path $greenDir "platforms\qwindows.dll"))) {
    throw "绿色版里出现 Qt 产物，dist\Mote-Windows 不是原生外壳的产物"
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
