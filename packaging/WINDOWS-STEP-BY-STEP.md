# Windows 上手：一步一步（拉代码 / 提交 / 推回）

按本仓库真实状态写：远程 `git@gitee.com:lin-yuwei168/mote-md.git`，只有 `main` 一条分支，
行尾由仓库根的 `.gitattributes` 决定（`.sh`=LF、`.bat`/`.cmd`=CRLF，其余 `text=auto`）。
完整原理与更多分支见 [WINDOWS-SETUP.md](WINDOWS-SETUP.md)；Windows 编译/打包见 [WINDOWS-FROM-MACOS.md](WINDOWS-FROM-MACOS.md)。

**未验证声明**：本文在 macOS 上整理，命令取自 Git for Windows 默认安装与 PowerShell 5.1 的公开行为，
**没有在 Windows 上实际执行过**；Gitee 网页入口与 GCM 弹窗形态以你打开时的页面为准。不确定处都标了「不确定」。

约定：`你的名字`、`你的邮箱` 要替换；所有命令都在 **PowerShell** 里执行（不是 CMD）。

---

## 一、第一次接入

### 1. 确认 PowerShell 版本

```powershell
$PSVersionTable.PSVersion
```

成功：显示 `5.1.x` 或 `7.x`。显示 `4.0` 说明系统很旧（Windows 8.1 之前），命令不保证可用。

### 2. 装 Git

```powershell
git --version
```

成功：输出 `git version 2.4x.windows.1`（任意 `2.x` 都行）。

提示「无法将"git"项识别为 cmdlet」时：

```powershell
winget install --id Git.Git -e --source winget
```

装完**关掉所有 PowerShell 窗口重开**（PATH 不会热更新），再跑一次 `git --version`，判断同上。
没有 winget（系统较旧）：从 <https://git-scm.com/download/win> 下 64-bit 安装包，安装时全部默认。

### 3. 建目录

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\dev" | Out-Null
Test-Path "$env:USERPROFILE\dev"
```

成功：`Test-Path` 输出 `True`。

不要在 OneDrive / 中文 / 带空格的路径下放仓库：OneDrive 会锁文件（`index.lock` 报错），中文路径在部分工具链下有编码问题。
**不确定**：中文路径的具体表现我没实测。

### 4. 选凭据路线（二选一）

#### 4A. SSH（推荐，长期不用管）

**4A-1 生成密钥**

```powershell
ssh-keygen -t ed25519 -C "windows-$(hostname)" -f "$env:USERPROFILE\.ssh\id_ed25519"
```

`Enter passphrase` 直接回车两次（不设口令）。若提示 `... already exists. Overwrite (y/n)?` 输 `n`，直接跳到 4A-2 复用旧密钥。

成功：输出 `Your identification has been saved in C:\Users\<你>\.ssh\id_ed25519`，且

```powershell
Get-ChildItem "$env:USERPROFILE\.ssh"
```

能看到 `id_ed25519` 和 `id_ed25519.pub` 两个文件。

**4A-2 复制公钥**

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
Get-Clipboard
```

成功：`Get-Clipboard` 输出**恰好一行**，以 `ssh-ed25519 AAAAC3...` 开头、以 `windows-机器名` 结尾。

**4A-3 贴到 Gitee**

网页路径：登录 gitee.com → 右上头像 → **设置** → 左栏 **安全设置 → SSH 公钥** →
标题填 `windows-<机器名>` → 公钥框粘贴 → **确定**（可能要求再输一次登录密码）。

成功：公钥列表新增一条，其指纹与下面命令输出一致（比对 `SHA256:` 后那串）：

```powershell
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

贴的是带 `.pub` 的那一行，不是私钥；多贴空行也会失败。

**4A-4 验证**

```powershell
ssh -T git@gitee.com
```

首次会问 `Are you sure you want to continue connecting (yes/no/[fingerprint])?` → 输 `yes` 回车。

成功：出现 `Hi lin-yuwei168! You've successfully authenticated, but GITEE.COM does not provide shell access.` 这类句子，
且 `echo $LASTEXITCODE` 为 `0`（Gitee 不给 shell，这是正常的）。

**不确定**：我没在 Windows 上看到这条输出的原文，措辞可能略有差异，含 `successfully authenticated` 即算通过。

#### 4B. HTTPS + 私人令牌

**4B-1 生成令牌**

网页路径：头像 → 设置 → **安全设置 → 私人令牌** → **生成新令牌** →
只勾**仓库读写**相关项（Gitee 权限列表里对应 `projects`；`issues`/`pull_requests`/`hook` 等本仓库用不到）→ 提交。

**不确定**：权限项名称以页面当前文案为准，我没登录核对；只要保证能读写仓库即可。

成功：页面**只显示一次**令牌字符串，立刻复制存进密码管理器，离开就再也看不到。

**4B-2 确认凭据助手**

```powershell
git config --show-origin --get-all credential.helper
```

成功：有输出且含 `manager`（Git for Windows 默认 `manager` 或 `manager-core`），
此时令牌会被 Windows 凭据管理器保存，之后不再询问。

没有输出时：

```powershell
git config --global credential.helper manager
```

这一条写全局，但它只决定「凭据存哪」，不影响提交身份与行尾。

**4B-3 不要做的事**

不要把令牌写进 URL（`https://用户名:令牌@gitee.com/...`）：它会留在 `.git/config`、命令历史和日志里，泄露后必须立刻吊销。

**4B-4 验证时机**

首次 clone 时弹窗：用户名 = **Gitee 用户名**，密码 = **令牌**。

**不确定**：若弹的是浏览器 OAuth 页面，是 GCM 对 GitHub/GitLab 的流程，Gitee 不一定支持；选 `Token`/`Personal Access Token` 方式粘贴令牌。
我没实测 GCM 与 Gitee 的交互形态。

### 5. clone

SSH：

```powershell
git clone git@gitee.com:lin-yuwei168/mote-md.git "$env:USERPROFILE\dev\mote-md"
```

HTTPS（走 4B 的人用这条）：

```powershell
git clone https://gitee.com/lin-yuwei168/mote-md.git "$env:USERPROFILE\dev\mote-md"
```

成功：末尾有 `Resolving deltas: 100% ... done.`，且

```powershell
Get-ChildItem "$env:USERPROFILE\dev\mote-md"
```

能看到 `Mote.pro`、`src`、`resources`、`packaging`。

报 `fatal: destination path ... already exists` → 第三段第 5 条。

### 6. 配仓库级身份

```powershell
cd "$env:USERPROFILE\dev\mote-md"
git config user.name  "你的名字"
git config user.email "你的邮箱"
git config --local --list | Select-String "user\."
```

成功：`Select-String` 正好输出两行（`user.name=...`、`user.email=...`），且不涉及 `--global`。

邮箱建议与 Gitee 账号一致，提交才会关联到你的头像/贡献图。

再确认没有被全局行尾规则干扰：

```powershell
git config --show-origin --get-all core.autocrlf
```

成功：**没有任何输出**。
若有输出（`true` 或 `input`）：

```powershell
git config --global --unset core.autocrlf
```

只删这条旧值，不加新值。行尾以 `.gitattributes` 为唯一依据，叠加 `autocrlf` 会制造整文件 diff。

### 7. 三条验收（都要过）

**7.1 工作区干净**

```powershell
git status -sb
```

成功：只有一行 `## main...origin/main`，没有 `M`、没有 `??`。

**7.2 哈希与 Mac 侧一致**

```powershell
git fetch origin
git rev-parse origin/main
git rev-parse HEAD
```

成功：两个 40 位哈希**完全相同**。Mac 侧跑 `git rev-parse HEAD` 应得到同一个值。
写这份文档时是 `ed3b69f90fd5ad4b65dc9982e0e25d6db39d6c81`，之后会变，以你跑出来的为准。
这条真正的用途是**以后**每次 push 前后复检。

**7.3 行尾**

```powershell
git ls-files --eol packaging/package_macos.sh packaging/package_windows.bat
```

成功：第一行含 `w/lf`（`package_macos.sh`），第二行含 `w/crlf`（`package_windows.bat`）；两行 `i/` 都是 `i/lf`。
`w/` 是工作区，`i/` 是入库内容——入库统一 LF 是对的。

不信 Git 时直接数字节：

```powershell
$b=[IO.File]::ReadAllBytes("packaging\package_windows.bat"); "CR=$(( $b -eq 13 ).Count) LF=$(( $b -eq 10 ).Count)"
```

成功：`CR` 与 `LF` 相等且都大于 0。

**7.4 用脚本一次跑完 7.1–7.3（可选）**

```powershell
powershell -ExecutionPolicy Bypass -File packaging\setup_windows.ps1 -UserName "你的名字" -UserEmail "你的邮箱"
echo $LASTEXITCODE
```

成功：每行以 `[OK]` 开头，末尾 `仓库已就绪`，`$LASTEXITCODE` 为 `0`。
退出码：`2` 未装 Git、`3` 目录非空、`4` clone 失败、`5` 验收未过。
提示「禁止运行脚本 / 未对文件进行数字签名」就是漏了 `-ExecutionPolicy Bypass`，照上面整条命令跑。

### 8. 用 Trae 打开

Trae → **文件 → 打开文件夹** → 选 `C:\Users\<你>\dev\mote-md` → 信任该文件夹。

成功：左侧资源树出现 `src` / `resources` / `packaging`；`Ctrl+P` 输入 `WINDOWS-SETUP` 能打开对应文档。

检查终端：Trae 里新开的终端右下角应显示 **PowerShell**。
若是 `WSL` / `bash`，那是另一套环境——SSH 密钥、凭据管理器、行尾规则都不通，切回 PowerShell 再用。

---

## 二、日常协作

### 1. 开工

```powershell
cd "$env:USERPROFILE\dev\mote-md"
git status -sb
git pull --rebase
```

成功：`Already up to date.` 或 `Successfully rebased and updated refs/heads/main.`；
`git status -sb` 仍只有 `## main...origin/main`，不带 `[ahead N]` / `[behind N]`。

`git status` 有 `M`/`??` 时先提交，或 `git stash push -m "wip"`；
报 `Your local changes ... would be overwritten` 也是这个原因：stash → pull → `git stash pop`。

### 2. 改完提交

```powershell
git status --short
git add resources/web/editor.css
git commit -m "目录栏整栏改为手型光标，避免条目间移动时闪烁"
```

成功：输出 `[main <7位哈希>] 目录栏...` 和 `1 file changed, N insertions(+)`。

粒度：一事一提交，源码/文档/脚本分开；**显式列文件，不用 `git add -A`**（会把 `.mote-preview-*.html` 这类调试产物带进来）。
提交信息写「为什么」。
中文提交信息在 PowerShell 5.1 可能乱码：先 `chcp 65001`，或把信息写进文件用 `git commit -F msg.txt`。

### 3. 推送

```powershell
git fetch origin
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
```

成功：第一行命令只列出**你自己的**提交，`diff --stat` 只含你改的文件。

```powershell
git push
```

成功：末尾 `main -> main`（形如 `abc1234..def5678  main -> main`）；
再跑 `git status -sb`，`## main...origin/main` 不再带 `[ahead 1]`。

硬规矩：不 `push --force`；没 pull 过不 push；被拒就 `pull --rebase` 再推。

---

## 三、出错怎么办

### 1. `无法将"git"项识别为 cmdlet、函数、脚本文件或可运行程序的名称`

判断：Git 没装，或装了但终端是安装前打开的（PATH 未刷新）。

```powershell
winget install --id Git.Git -e --source winget
```

然后**关闭所有终端窗口重开**：

```powershell
git --version
```

### 2. `Permission denied (publickey).`

判断：Gitee 上没有这把公钥，或贴错（贴了私钥、多贴空行），或密钥不在默认文件名上。

```powershell
ssh -vT git@gitee.com
ssh-keygen -lf "$env:USERPROFILE\.ssh\id_ed25519.pub"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
```

把剪贴板内容重新贴到 Gitee（安全设置 → SSH 公钥）；
再核对远端地址不是 HTTPS：

```powershell
git remote -v
```

### 3. `Connection timed out` / `Could not resolve host: gitee.com`

判断：22 端口被公司网络或防火墙拦，或根本没有外网/DNS。

```powershell
Test-NetConnection gitee.com -Port 443
ssh -T -p 443 git@ssh.gitee.com
```

443 那条能通就换入口：

```powershell
git remote set-url origin ssh://git@ssh.gitee.com:443/lin-yuwei168/mote-md.git
```

两条都不通：改走 4B 的 HTTPS（443 一般放行）。

### 4. HTTPS `Authentication failed` / 反复弹窗 / `403`

判断：密码用了登录密码而不是令牌，或缓存了旧凭据。

```powershell
cmdkey /list | Select-String gitee
cmdkey /delete:git:https://gitee.com
git push
```

弹窗里用户名 = Gitee 用户名，密码 = 私人令牌。
仍失败就重新生成令牌（旧的可能过期或被吊销），删掉旧凭据再试。

### 5. `fatal: destination path ... already exists and is not an empty directory.`

判断：目标目录已有内容，clone 拒绝覆盖。

```powershell
Rename-Item "$env:USERPROFILE\dev\mote-md" "$env:USERPROFILE\dev\mote-md.bak"
git clone git@gitee.com:lin-yuwei168/mote-md.git "$env:USERPROFILE\dev\mote-md"
```

或者直接换目录（`...\dev\mote-md2`）。不要手工删不认识的文件。

### 6. `! [rejected] main -> main (non-fast-forward)`

判断：远端有别人（或你另一台机器）推的提交，本地落后。

```powershell
git pull --rebase
git push
```

出冲突就按第 7 条处理。**不要** `git push --force`——会把别人已推的提交从远端抹掉。

### 7. `CONFLICT (content): Merge conflict in <file>` / `could not apply <hash>`

判断：同一文件的同一处两边都改了，rebase 停在半路。

```powershell
git status
git diff --name-only --diff-filter=U
```

打开冲突文件，删掉 `<<<<<<<` `=======` `>>>>>>>` 三行、留下想要的内容，然后：

```powershell
git add <冲突文件>
git rebase --continue
```

多个文件就重复「编辑 → `git add` → `git rebase --continue`」。
整段放弃、回到动手前：

```powershell
git rebase --abort
```

整文件取一边（**rebase 期间语义和 merge 相反**）：

```powershell
git checkout --ours   -- <file>   # 取远端/别人的版本
git checkout --theirs -- <file>   # 取你自己这次提交的版本
```

`.png`/`.icns`/`.ico`/`.ttf` 不能逐行合并，同样用 `--ours`/`--theirs` 选一个，再 `git add`。

### 8. `git status` 一堆 `M`，`git diff` 像整文件重写但内容一样

判断：行尾被全局 `core.autocrlf` 或编辑器改过，叠加在 `.gitattributes` 之上。

```powershell
git config --show-origin --get-all core.autocrlf
git config --global --unset core.autocrlf
git stash push -m "wonky-eol"
git rm --cached -r .
git reset --hard
git ls-files --eol packaging/package_macos.sh packaging/package_windows.bat
```

成功：`.sh` 是 `w/lf`、`.bat` 是 `w/crlf`，`git status -sb` 干净。

`git reset --hard` 会丢弃未提交改动，所以前面先 stash；确认没问题再 `git stash drop`。

---

## 四、这份文档的状态

由 macOS 侧整理，**未在 Windows 上实测**；`setup_windows.ps1` 同样未实测。
Gitee 页面（SSH 公钥、私人令牌权限项）与 Git Credential Manager 的弹窗形态以你实机为准。
实机跑完后把实际输出反馈回来，我再校正文中期望值。
