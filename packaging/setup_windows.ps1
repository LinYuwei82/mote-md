#Requires -Version 5.1
<#
.SYNOPSIS
  在 Windows 上把 mote-md 仓库拉下来、配好仓库级身份，并做行尾/哈希校验。

.DESCRIPTION
  只做「拉代码 + 身份配置 + 验收」这三件事，不安装任何软件、不改任何全局 Git 配置。
  详细步骤与原理见 packaging\WINDOWS-SETUP.md。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\setup_windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\setup_windows.ps1 `
    -Https -UserName "你的名字" -UserEmail "you@example.com" -Target D:\dev\mote-md
#>
[CmdletBinding()]
param(
    # clone 到的目录；已存在且是同一个仓库时只做校验，不重复 clone
    [string]$Target = (Join-Path $env:USERPROFILE 'dev\mote-md'),

    # 走 HTTPS + 私人令牌（默认走 SSH）
    [switch]$Https,

    [string]$SshUrl   = 'git@gitee.com:lin-yuwei168/mote-md.git',
    [string]$HttpsUrl = 'https://gitee.com/lin-yuwei168/mote-md.git',

    # 仓库级提交身份；不给就交互询问，留空则跳过（不会去改全局配置）
    [string]$UserName,
    [string]$UserEmail
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "== $text" -ForegroundColor Cyan
}
function Write-Ok([string]$text)   { Write-Host "  [OK]   $text" -ForegroundColor Green }
function Write-Warn2([string]$text){ Write-Host "  [注意] $text" -ForegroundColor Yellow }
function Write-Bad([string]$text)  { Write-Host "  [失败] $text" -ForegroundColor Red }

function Exit-With([int]$code, [string]$message) {
    Write-Host ""
    Write-Bad $message
    Write-Host ""
    exit $code
}

Write-Host ""
Write-Host "mote-md / Windows 接入脚本（只配仓库级设置，不改全局）" -ForegroundColor White
Write-Host "目标目录: $Target"

# ---------------------------------------------------------------- 1. Git
Write-Step "1/5 检查 Git"
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Bad "没有找到 git 命令。"
    Write-Host ""
    Write-Host "  请先安装 Git for Windows，二选一：" -ForegroundColor Yellow
    Write-Host "    winget install --id Git.Git -e --source winget"
    Write-Host "    或 https://git-scm.com/download/win"
    Write-Host ""
    Write-Host "  装完请【重开一个终端】再运行本脚本（PATH 不会热更新）。"
    Write-Host "  本脚本不会代替你安装任何软件。"
    exit 2
}
$gitVersion = (& git --version) -join ''
Write-Ok $gitVersion

# 只看不改：把可能干扰行尾判断的全局设置暴露出来
$autocrlf = (& git config --global --get-all core.autocrlf 2>$null)
if ($autocrlf) {
    Write-Warn2 "检测到全局 core.autocrlf = $($autocrlf -join ', ')"
    Write-Host "         仓库用 .gitattributes 固定行尾，全局设置会被叠加上去，可能造成整文件 diff。"
    Write-Host "         建议（手工执行，本脚本不会动全局配置）：git config --global --unset core.autocrlf"
}

# ---------------------------------------------------------------- 2. 目录
Write-Step "2/5 准备目录"
$url = if ($Https) { $HttpsUrl } else { $SshUrl }
Write-Host "  远程: $url"

$reused = $false
if (Test-Path -LiteralPath $Target) {
    $isRepo = Test-Path -LiteralPath (Join-Path $Target '.git')
    if ($isRepo) {
        $existing = (& git -C $Target remote get-url origin 2>$null)
        if ($existing -and ($existing -ne $url)) {
            Write-Warn2 "$Target 已是一个 Git 仓库，但 origin 不同："
            Write-Host "         现有: $existing"
            Write-Host "         预期: $url"
            Write-Host "         继续会在该目录做校验。要换地址请手工：git -C `"$Target`" remote set-url origin $url"
        }
        Write-Ok "复用已有仓库：$Target（跳过 clone）"
        $reused = $true
    }
    elseif (@(Get-ChildItem -LiteralPath $Target -Force).Count -gt 0) {
        Write-Bad "$Target 已存在且非空，但不是 Git 仓库，为避免覆盖已有文件，脚本停止。"
        Write-Host ""
        Write-Host "  三选一：" -ForegroundColor Yellow
        Write-Host "    1) 换一个目录：-Target D:\dev\mote-md"
        Write-Host "    2) 手工确认无用后清空该目录再重跑"
        Write-Host "    3) 改名备份：Rename-Item `"$Target`" `"$Target.bak`""
        exit 3
    }
    else {
        Write-Ok "目录为空，直接使用"
    }
}

if (-not $reused) {
    $parent = Split-Path -Parent $Target
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Write-Ok "已创建上级目录 $parent"
    }
    Write-Host "  正在 clone（首次可能较慢）..."
    & git clone $url $Target
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Bad "clone 失败（退出码 $LASTEXITCODE）。常见原因："
        if ($Https) {
            Write-Host "  - 凭据不对：Gitee 的 HTTPS 密码必须用【私人令牌】，不是登录密码"
            Write-Host "  - 缓存了旧凭据：cmdkey /delete:git:https://gitee.com 后重试"
            Write-Host "  - 网络/代理：确认能打开 https://gitee.com"
        }
        else {
            Write-Host "  - 公钥没加到 Gitee：先跑 ssh -T git@gitee.com 看是否 Hi 你的用户名"
            Write-Host "  - 22 端口被拦：试 ssh -T -p 443 git@ssh.gitee.com，并把 origin 改成 443 入口"
            Write-Host "  - 网络/代理：确认能打开 https://gitee.com，且防火墙允许 22 端口出站"
            Write-Host "  - 想改用令牌：加 -Https 重新运行"
        }
        Write-Host "  详细排查见 packaging\WINDOWS-SETUP.md 第 2、3 节。"
        exit 4
    }
    Write-Ok "clone 完成：$Target"
}

# ---------------------------------------------------------------- 3. 身份
Write-Step "3/5 仓库级提交身份"
$curName  = (& git -C $Target config --local --get user.name 2>$null)
$curEmail = (& git -C $Target config --local --get user.email 2>$null)
if ($curName -and $curEmail) {
    Write-Ok "已有仓库级身份：$curName <$curEmail>"
}
else {
    if (-not $UserName)  { $UserName  = Read-Host "  user.name（提交作者名，回车跳过）" }
    if (-not $UserEmail) { $UserEmail = Read-Host "  user.email（建议与 Gitee 账号一致，回车跳过）" }

    if ($UserName)  { & git -C $Target config user.name  $UserName;  Write-Ok "user.name  = $UserName" }
    if ($UserEmail) { & git -C $Target config user.email $UserEmail; Write-Ok "user.email = $UserEmail" }
    if (-not ($UserName -and $UserEmail)) {
        Write-Warn2 "身份未配全，提交时 Git 会报 \"Please tell me who you are\"；补配命令："
        Write-Host "         git -C `"$Target`" config user.name  `"你的名字`""
        Write-Host "         git -C `"$Target`" config user.email `"你的邮箱`""
    }
    Write-Host "  （只写仓库级，未触碰 --global 配置）"
}

# ---------------------------------------------------------------- 4. 验收
Write-Step "4/5 验收：工作区 / 哈希 / 行尾"
$failures = 0

# 4.1 工作区干净
$porcelain = (& git -C $Target status --porcelain 2>$null)
if ([string]::IsNullOrWhiteSpace(($porcelain -join ''))) {
    Write-Ok "git status 干净"
}
else {
    $failures++
    Write-Bad "git status 不干净，以下文件被改动："
    $porcelain | ForEach-Object { Write-Host "         $_" }
    Write-Host "         若只是行尾差异：git -C `"$Target`" config --get core.autocrlf 确认为空，"
    Write-Host "         再执行 git -C `"$Target`" rm --cached -r . ; git -C `"$Target`" reset --hard"
}

# 4.2 当前提交
$head = (& git -C $Target rev-parse HEAD 2>$null)
$subject = (& git -C $Target log -1 --format=%s 2>$null)
Write-Ok "HEAD = $head"
Write-Host "         提交说明: $subject"
Write-Host "         在 Mac 侧执行 git rev-parse HEAD 应与上面完全一致；若不一致，"
Write-Host "         先 git -C `"$Target`" pull --rebase 再比。"

# 4.3 行尾
$expect = @{
    'packaging/package_macos.sh'  = 'w/lf'
    'packaging/package_windows.bat' = 'w/crlf'
}
$eolLines = (& git -C $Target ls-files --eol packaging/package_macos.sh packaging/package_windows.bat 2>$null)
foreach ($line in $eolLines) {
    Write-Host "         $line"
    foreach ($file in $expect.Keys) {
        if ($line -match [regex]::Escape($file)) {
            if ($line -notmatch [regex]::Escape($expect[$file])) {
                $failures++
                Write-Bad "$file 期望 $($expect[$file])，实际不是"
                if ($expect[$file] -eq 'w/crlf') {
                    Write-Host "         若这个 clone 早于 .gitattributes 加 eol=crlf 的那次提交，重检一次即可："
                    Write-Host "         git -C `"$Target`" rm --cached -r . ; git -C `"$Target`" reset --hard"
                }
            }
        }
    }
}
if (-not $eolLines) {
    $failures++
    Write-Bad "读不到行尾信息（文件缺失或不在仓库里）"
}

# 字节级复核，不依赖 Git 配置
function Measure-Eol([string]$path) {
    $full = Join-Path $Target $path
    if (-not (Test-Path -LiteralPath $full)) { return "缺失" }
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $cr = 0; $lf = 0
    foreach ($b in $bytes) {
        if ($b -eq 13) { $cr++ }
        elseif ($b -eq 10) { $lf++ }
    }
    if ($cr -eq 0 -and $lf -gt 0) { return 'LF' }
    if ($cr -gt 0 -and $cr -eq $lf) { return 'CRLF' }
    return "混合(CR=$cr LF=$lf)"
}
$shEol  = Measure-Eol 'packaging/package_macos.sh'
$batEol = Measure-Eol 'packaging/package_windows.bat'
if ($shEol -eq 'LF')   { Write-Ok "package_macos.sh 字节检查 = LF" }   else { $failures++; Write-Bad "package_macos.sh 字节检查 = $shEol（期望 LF）" }
if ($batEol -eq 'CRLF'){ Write-Ok "package_windows.bat 字节检查 = CRLF" } else { $failures++; Write-Bad "package_windows.bat 字节检查 = $batEol（期望 CRLF）" }

# ---------------------------------------------------------------- 5. 下一步
Write-Step "5/5 完成"
if ($failures -gt 0) {
    Write-Bad "有 $failures 项未通过，先别开始改代码。排查顺序见 packaging\WINDOWS-SETUP.md 第 4 节。"
    exit 5
}

Write-Host "  仓库已就绪：$Target" -ForegroundColor Green
Write-Host ""
Write-Host "  日常三条（都在仓库目录里执行）："
Write-Host "    git pull --rebase                    # 开工前"
Write-Host "    git add <具体文件>; git commit -m `"...`""
Write-Host "    git push                             # 推之前先 git fetch 看一眼"
Write-Host ""
Write-Host "  硬规矩：不要 git push --force；没有 pull 过就不要直接 push。"
Write-Host "  冲突、并发改动、凭据排查：packaging\WINDOWS-SETUP.md 第 5、6 节。"
Write-Host "  要在 Windows 上编译/打包：packaging\WINDOWS-FROM-MACOS.md。"
Write-Host ""
Write-Host "  注意：本脚本由 macOS 侧编写，未在 Windows 上实测过；上面的校验结果请自己再确认一遍。" -ForegroundColor Yellow
exit 0
