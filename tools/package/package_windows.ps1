# Windows 原生薄外壳打包
# 用法：在已加载 MSVC 环境的 PowerShell 中执行
#   powershell -ExecutionPolicy Bypass -File tools\package\package_windows.ps1
# 产物：dist\Mote-Windows\ 与 dist\Mote-Windows.zip（Windows 发布包）

param(
    [string]$BuildDir = "",
    [string]$OutName = "Mote-Windows",
    [string]$Build = "",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $BuildDir) { $BuildDir = Join-Path $root "build/windows" }
$dist = Join-Path $root "dist"
$out = Join-Path $dist $OutName
$zip = Join-Path $dist "$OutName.zip"
$sdk = if ($env:WEBVIEW2_SDK) { $env:WEBVIEW2_SDK } else { "C:/dev/webview2sdk/pkg" }
$loader = Join-Path $sdk "build/native/x64/WebView2Loader.dll"

function Fail([string]$message) {
    Write-Host "[失败] $message"
    exit 1
}

if (-not $SkipBuild) {
    Write-Host "[1/6] 构建原生 Release"
    if ([string]::IsNullOrWhiteSpace($Build)) {
        # 正式发布应显式传 -Build <tag 序号>（build = seq，从 1 起，无固定基数）；
        # 未传时用 gen_build.py 兜底，仅供本地试打包。
        $py = Get-Command python -ErrorAction SilentlyContinue
        if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
        if (-not $py) { Fail "找不到 python（gen_build.py 需要）；可改用 -Build 显式指定构建号" }
        $genOut = (& $py.Source (Join-Path $root "tools\release\gen_build.py") `
            --product mote --repo-root $root 2>&1 | Select-Object -Last 1)
        if ($LASTEXITCODE -ne 0 -or "$genOut" -notmatch '^\d+$') {
            Fail "gen_build.py 失败：$genOut（可改用 -Build 显式指定构建号）"
        }
        $Build = "$genOut".Trim()
        Write-Host "构建号：$Build（来源 gen_build.py）"
    } else {
        if ($Build -notmatch '^\d+$') { Fail "非法构建号：$Build（应为纯数字）" }
        Write-Host "构建号：$Build（来源 -Build）"
    }
    # -DMOTE_RELEASE_BUILD=ON：发布态门禁（占位构建号 / 缺 Sparkle 等直接 FATAL）
    cmake -S (Join-Path $root "native") --preset windows-release `
        -DMOTE_BUILD="$Build" -DMOTE_RELEASE_BUILD=ON | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "cmake configure 失败（退出码 $LASTEXITCODE）" }
    cmake --build $BuildDir | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "cmake --build 失败" }
}

$exe = Join-Path $BuildDir "Mote.exe"
if (-not (Test-Path $exe)) { Fail "未找到 $exe（先构建或检查 -BuildDir）" }
if (-not (Test-Path $loader)) { Fail "未找到 $loader（设置 WEBVIEW2_SDK）" }

# 发布清单的 build 必须等于编译时的 MOTE_BUILD，否则客户端会反复提示同一版本；
# 自动构建（上面的 configure）会把构建号写进 CMakeCache，发布脚本直接读取。
$cacheFile = Join-Path $BuildDir "CMakeCache.txt"
if (Test-Path -LiteralPath $cacheFile) {
    $stamp = [regex]::Match((Get-Content -LiteralPath $cacheFile -Raw), 'MOTE_BUILD:[A-Z]+=(\d+)').Groups[1].Value
    if ($stamp -and $stamp -ne "0") {
        Write-Host "构建号 MOTE_BUILD=$stamp（发布时清单必须写同一个值）"
    } else {
        Write-Host "[提示] 本次构建未设置 MOTE_BUILD，发布脚本会从 zip 内 Mote.exe 自动识别构建号"
    }
}

Write-Host "[2/6] 清理并创建产物目录"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
if (Test-Path $zip) { Remove-Item $zip -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "[3/6] 复制可执行文件与 WebView2 Loader"
Copy-Item $exe $out
Copy-Item $loader $out
# CMake 已把 loader 拷到构建目录；以 SDK 里那份为准再覆盖一次，版本不受构建目录残留影响

Write-Host "[4/6] 复制页面资源、示例与许可证"
# 外壳在 exe 同级的 web/ 与 fonts/ 里找编辑器和内嵌字体，缺一不可
Copy-Item (Join-Path $BuildDir "web") $out -Recurse
Copy-Item (Join-Path $BuildDir "fonts") $out -Recurse
$samples = Join-Path $out "samples"
New-Item -ItemType Directory -Force -Path $samples | Out-Null
Copy-Item (Join-Path $root "resources/samples/welcome.md") $samples
Copy-Item (Join-Path $root "resources/samples/sample-diagram.png") $samples
$licenses = Join-Path $out "licenses"
New-Item -ItemType Directory -Force -Path $licenses | Out-Null
Copy-Item (Join-Path $root "resources/fonts/OFL.txt") (Join-Path $licenses "JetBrainsMono-OFL.txt")
Copy-Item (Join-Path $root "LICENSE") (Join-Path $licenses "LICENSE-AGPL-3.0.txt")

Write-Host "[5/6] 自检：无 Qt 依赖"
$qtFiles = Get-ChildItem $out -Recurse -File | Where-Object { $_.Name -like "Qt6*.dll" }
if ($qtFiles) { Fail ("产物里出现 Qt DLL：" + ($qtFiles.Name -join ", ")) }
if (Test-Path (Join-Path $out "platforms/qwindows.dll")) { Fail "产物里出现 platforms/qwindows.dll" }

$dumpbin = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
if (-not $dumpbin) {
    $vsRoot = "C:\Program Files\Microsoft Visual Studio\2022"
    $candidate = Get-ChildItem $vsRoot -Recurse -Filter dumpbin.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*Hostx64\x64*" } | Select-Object -First 1
    if ($candidate) { $dumpbin = $candidate.FullName }
}
if (-not $dumpbin) { Fail "找不到 dumpbin.exe（在 VS 开发者环境中运行）" }
$dump = & $dumpbin /dependents (Join-Path $out "Mote.exe") | Out-String
$deps = [regex]::Matches($dump, "(?im)^\s*([A-Za-z0-9_.\-]+\.dll)\s*$") |
    ForEach-Object { $_.Groups[1].Value }
$allowed = @(
    "USER32.dll", "ole32.dll", "OLEAUT32.dll", "ADVAPI32.dll", "SHLWAPI.dll",
    "SHELL32.dll", "COMCTL32.dll", "KERNEL32.dll", "GDI32.dll", "COMDLG32.dll",
    "VERSION.dll", "WINMM.dll", "WS2_32.dll", "DWMAPI.dll", "UXTHEME.dll",
    "WINHTTP.dll", "BCRYPT.dll", "ntdll.dll", "WebView2Loader.dll"
)
$unexpected = $deps | Where-Object { $allowed -notcontains $_ -and $_ -notlike "api-ms-*" }
if ($unexpected) { Fail ("依赖里出现非系统/非 Loader DLL：" + ($unexpected -join ", ")) }

Write-Host "[6/6] 压缩"
Compress-Archive -Path $out -DestinationPath $zip -Force

$exeSize = (Get-Item (Join-Path $out "Mote.exe")).Length
$loaderSize = (Get-Item (Join-Path $out "WebView2Loader.dll")).Length
$zipSize = (Get-Item $zip).Length
Write-Host ""
Write-Host "原生打包完成："
Write-Host ("  exe     {0:N0} 字节" -f $exeSize)
Write-Host ("  loader  {0:N0} 字节" -f $loaderSize)
Write-Host ("  zip     {0:N0} 字节  {1}" -f $zipSize, $zip)
Write-Host ("  deps    " + ($deps -join ", "))
if (($exeSize + $loaderSize) -gt 3MB) { Fail "exe + loader 超过 3 MB 目标" }
if ($zipSize -gt 2MB) { Fail "zip 超过 2 MB 目标" }
