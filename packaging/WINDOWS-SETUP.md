# Windows 端接入：拉代码 / 提交 / 推回

面向「第一次在这台 Windows 上接手这个仓库」的人。只讲同步链路，不讲 Git 教程；
Windows 侧的编译与打包在 [WINDOWS-FROM-MACOS.md](WINDOWS-FROM-MACOS.md)，本文只在第 7 节说明它与同步的关系。

仓库真实状态（写这份文档时）：

| 项 | 值 |
| --- | --- |
| 远程 | `git@gitee.com:lin-yuwei168/mote-md.git`（HTTPS 等价地址 `https://gitee.com/lin-yuwei168/mote-md.git`） |
| 分支 | `main`（只有这一条长期分支） |
| 行尾规则 | 仓库根目录已有 `.gitattributes`：`* text=auto`、`*.sh text eol=lf`、`*.bat`/`*.cmd text eol=crlf`、图片/字体 `-text` |
| 忽略目录 | `/dist/`、`/build/`、`/build-*/`、`/*_build/` 已在 `.gitignore` |
| Mac 侧 HEAD（写本文时） | `491e7682fb3691d466b8a19b803771e81a8a5e0e`（`491e768`） |

> 最后一行会变。验收时不要死记这个哈希，而是**两边用同一条命令对比**
> （第 4 节），以当下 `origin/main` 为准。

---

## 0. 一页速查

已装 Git、已配好凭据的情况下，从零到能干活就这几行：

```powershell
git clone git@gitee.com:lin-yuwei168/mote-md.git $env:USERPROFILE\dev\mote-md
cd $env:USERPROFILE\dev\mote-md
git config user.name  "你的名字"      # 仓库级，只影响这一个 clone，见 1.2
git config user.email "你的邮箱"
git status -sb
git ls-files --eol tools/package/package_macos.sh tools/release/publish_windows.ps1
```

没装 Git 先看 1.1；走 HTTPS + 令牌把第一行的地址换成 `https://gitee.com/lin-yuwei168/mote-md.git`，见第 3 节。

日常只有三条：

```powershell
git pull --rebase        # 开工前
git add <具体文件>; git commit -m "说明为什么改"
git push                 # 推之前先 fetch 看一眼，见第 5 节
```

**两条硬规矩**：不要 `git push --force`（尤其 `main`）；没有 `pull` 过就不要直接 `push`。

---

## 1. 先决条件与身份

### 1.1 装 Git

```powershell
git --version    # 期望输出 git version 2.x
```

没有的话：`winget install --id Git.Git -e --source winget`，或从 <https://git-scm.com/download/win> 装。
装完**重开一个终端**再验证（PATH 不会热更新）。

### 1.2 身份：写进仓库，不要写进全局

提交作者信息来自 `user.name` / `user.email`。这个仓库建议**只设仓库级**：

```powershell
cd $env:USERPROFILE\dev\mote-md
git config user.name  "你的名字"
git config user.email "你的邮箱"            # 建议与 Gitee 账号邮箱一致，提交才能关联到你的头像/贡献图
git config --local --list | Select-String "user\."
```

写全局（`--global`）也能用，但如果这台机器上还有别的项目（公司仓库、别人的账号），
全局身份会一起被改掉，提交记录里就会出现错误的作者。仓库级只影响这一个 clone。

### 1.3 不要动全局 `core.autocrlf`（重要）

仓库已经用 `.gitattributes` 把行尾钉死了：

```
* text=auto            # 默认：入库 LF，检出按平台（Windows 得到 CRLF）
*.sh  text eol=lf      # 脚本必须 LF
*.bat text eol=crlf    # 批处理必须 CRLF
*.cmd text eol=crlf
*.png/*.icns/*.ico/*.ttf -text   # 二进制不做转换
```

`core.autocrlf` 是**另一套并行规则**，跟 `.gitattributes` 叠加会出两类问题：

1. **属性没覆盖到的文件**会被全局规则改写。别人在 Mac 上以 LF 提交、你这边以 CRLF 检出，
   看起来正常；可一旦有人用 `autocrlf=input` 或者别的编辑器重存，`git diff` 就会变成
   **整文件 diff**，几百行「改动」其实只有行尾不同，review 和 merge 全被噪声淹没。
2. **`text=auto` 与 `autocrlf` 的判断顺序/优先级**会让同一文件在不同机器上反复翻转，
   出现「什么都没改但 `git status` 是脏的」。

因此：

```powershell
git config --show-origin --get-all core.autocrlf     # 期望：没有输出
```

如果确实被设过（`true` / `input` 都算），只在这台机器上清掉：

```powershell
git config --global --unset core.autocrlf            # 仅当输出里确实有它时才需要
```

**不要**设成 `true` 来「修」行尾问题；行尾以 `.gitattributes` 为唯一依据。
`.sh` 若被写成 CRLF，macOS 上会因 shebang 带 `\r` 直接跑不起来；`.bat` 若被写成 LF，
`cmd.exe` 的 `goto`/标签解析会出错——这也是这两类文件被显式钉死的原因。

---

## 2. 凭据路线 A：SSH（推荐，长期不用管）

### 2.1 生成密钥

```powershell
ssh-keygen -t ed25519 -C "windows-$(hostname)" -f $env:USERPROFILE\.ssh\id_ed25519
```

- 口令（passphrase）可以留空，也可以设；设了就要配合 `ssh-agent`（见 2.4）。
- 已有 `id_ed25519` 时不要覆盖，直接复用。
- 若系统里没有 `ssh-keygen`：设置 → 应用 → 可选功能 → 添加「OpenSSH 客户端」。

### 2.2 把公钥加到 Gitee

```powershell
Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | Set-Clipboard
```

Gitee → 头像 → 设置 → **安全设置 → SSH 公钥** → 粘贴 → 确定。
粘贴的是 `.pub`（以 `ssh-ed25519 AAAA...` 开头那一整行），**不是**没有 `.pub` 后缀的私钥。

### 2.3 验证

```powershell
ssh -T git@gitee.com
```

- 成功：`Hi 你的用户名! You've successfully authenticated...`（Gitee 不给 shell，这是正常的）。
- 首次连接会问 `Are you sure you want to continue connecting?`，输 `yes`。
- `Permission denied (publickey)`：公钥没贴对（贴了私钥/多贴了换行）、或 `ssh-keygen` 用了非默认文件名。

### 2.4 坑

| 现象 | 处理 |
| --- | --- |
| 22 端口被公司网络/运营商拦（`Connection timed out`） | Gitee 另提供 443 端口的 SSH 入口：先 `ssh -T -p 443 git@ssh.gitee.com` 验证；能用就把远端改成 `ssh://git@ssh.gitee.com:443/lin-yuwei168/mote-md.git`（以 Gitee 文档的入口为准） |
| 设了口令，每次 push 都问 | 启动 ssh-agent 并 `ssh-add $env:USERPROFILE\.ssh\id_ed25519`；Windows 上还要确认 `Get-Service ssh-agent` 为 Running，且启动类型设为自动 |
| 用管理员身份跑的终端找不到密钥 | 管理员账户的 `%USERPROFILE%` 不同；用普通终端，或把密钥复制到对应目录 |
| 远程地址仍是 HTTPS | `git remote -v` 核对；`git remote set-url origin git@gitee.com:lin-yuwei168/mote-md.git` |

---

## 3. 凭据路线 B：HTTPS + 私人令牌

Gitee 早已不接受账号密码，HTTPS 必须用**私人令牌（PAT）**当密码。

### 3.1 生成令牌

Gitee → 设置 → **安全设置 → 私人令牌** → 生成新令牌，至少勾选 `projects` 相关权限。
令牌只显示一次，先存到密码管理器。

### 3.2 clone 与保存

```powershell
git clone https://gitee.com/lin-yuwei168/mote-md.git $env:USERPROFILE\dev\mote-md
```

首次 `clone`/`push` 弹窗时：**用户名 = Gitee 用户名，密码 = 令牌**。
Windows 上 Git 默认使用 **Git Credential Manager（GCM）**，成功后凭据存进
「控制面板 → 用户账户 → 凭据管理器 → Windows 凭据」，条目名形如 `git:https://gitee.com`，
之后不再询问。

命令行核对/清理：

```powershell
cmdkey /list | Select-String gitee          # 看有没有缓存
cmdkey /delete:git:https://gitee.com        # 清掉旧凭据（401/403 时先清再重试）
```

### 3.3 坑

| 现象 | 处理 |
| --- | --- |
| `Authentication failed` / 反复弹窗 | 基本是缓存了旧密码：先 `cmdkey /delete` 再重试；或 `git config --global --unset credential.helper` 后重走一次 |
| 开了两步验证 | 必须用令牌，不能用登录密码 |
| 令牌过期 | 重新生成，删掉旧凭据 |
| 把令牌写进 URL | **不要**。`https://user:token@gitee.com/...` 会留在 `.git/config`、shell 历史、以及任何日志里；泄露后要立刻吊销令牌 |
| 公司代理 | `git config --global http.proxy http://host:port`，但这是全局配置，用完记得撤销 |

两条路线二选一即可。SSH 的好处是不用管令牌过期；HTTPS 的好处是不受 22 端口限制。

---

## 4. clone 后的验收（三条都要过）

```powershell
cd $env:USERPROFILE\dev\mote-md
```

### 4.1 工作区干净

```powershell
git status -sb
```

期望只有一行：`## main...origin/main`（不带 `M`/`??`）。若出现一堆 `M`，
说明行尾被本地规则改写了，回到 1.3 清掉 `core.autocrlf`，再：

```powershell
git rm --cached -r . ; git reset --hard      # 只在确认没有本地改动时执行
```

### 4.2 提交哈希与 Mac 侧一致

```powershell
git log -1 --format="%H %s"
```

Mac 侧执行同一条命令，两边的 `%H` 必须完全相同。写这份文档时是
`491e7682fb3691d466b8a19b803771e81a8a5e0e`；如果 Mac 后来又推了新的提交，
你这边先 `git pull --rebase` 再比对，**以 `origin/main` 为准**：

```powershell
git fetch origin; git rev-parse origin/main; git rev-parse HEAD    # 两个哈希应相同
```

### 4.3 抽两个文件确认行尾

仓库里正好有两类被 `.gitattributes` 钉死的脚本，用它们验收最直接：

```powershell
git ls-files --eol tools/package/package_macos.sh tools/release/publish_windows.ps1
```

期望输出（`w/` 是工作区，才是真正要看的）：

```
i/lf    w/lf      attr/text eol=lf      	tools/package/package_macos.sh
i/lf    w/crlf    attr/text=auto        	tools/release/publish_windows.ps1
```

两点说明，避免误判：

- **入库都是 `i/lf`**，这是对的（仓库统一存 LF）。
- 在 Mac 上跑同一条命令，`.ps1` 可能显示 `w/lf`：属性已经生效，仓库内容没问题，
  只是本地工作区没按平台行尾重新检出。Windows 上**全新 clone** 才会是 `w/crlf`；
  如果你那边也是 `w/lf`（例如用了很早以前的 clone），重检一次即可：

  ```powershell
  git rm --cached -r . ; git reset --hard
  ```

再直接数字节兜底（自己判断，不信配置）：

```powershell
function Test-Eol([string]$p) {
  $b = [IO.File]::ReadAllBytes((Resolve-Path $p))
  $cr = ($b | Where-Object { $_ -eq 13 }).Count
  $lf = ($b | Where-Object { $_ -eq 10 }).Count
  "{0,-38} CR={1,-5} LF={2,-5} -> {3}" -f $p, $cr, $lf,
    $(if ($cr -eq 0) { "LF" } elseif ($cr -eq $lf) { "CRLF" } else { "混合(异常)" })
}
Test-Eol tools/package/package_macos.sh              # 期望 LF
Test-Eol tools/release/publish_windows.ps1        # Windows 上期望 CRLF
```

出现「混合」就是有问题：不要提交它，先查 `.gitattributes` 是否被改动、
以及编辑器是否把文件另存成了别的行尾。

---

## 5. 日常协作流

### 5.1 开工前

```powershell
git fetch origin
git status -sb                 # 有本地改动先处理（提交或 git stash）
git pull --rebase              # 用 rebase，保持 main 线性，避免无意义的 merge 提交
```

`pull --rebase` 遇到本地未提交改动会拒绝执行，先 `git stash` 或先提交，别硬来。

### 5.2 提交粒度

- 一事一提交：改功能、改文档、改脚本分开；一个提交里既有源码又有打包产物是坏味道。
- 文案写**为什么**，不是「update」「fix」。
- 显式列文件，不要 `git add -A`：

```powershell
git add resources/web/editor.js resources/web/editor.css
git commit -m "目录栏整栏改为手型光标，避免条目间移动时闪烁"
```

- 不要把 `dist/`、`build/`、`.DS_Store`、`*.user` 带进来。它们已被 `.gitignore` 忽略，
  一旦出现在 `git status` 里，说明忽略规则被破坏，先查原因。

### 5.3 推送前

```powershell
git fetch origin
git log --oneline origin/main..HEAD        # 我这次要推几个提交
git diff --stat origin/main...HEAD         # 改了哪些文件
git status -sb                             # 确认 working tree 干净
git push
```

`git log` 里如果出现你**不认识**的提交，说明你是基于旧状态在推，先 rebase。

### 5.4 两边同时改同一个文件

Mac 和 Windows 同时在改（比如都在改 `resources/web/editor.css`）时：

1. **小块快推**。不要攒一天的改动再一次推，冲突面积和痛苦程度是超线性增长的。
2. 动手前先 `git pull --rebase`，改完尽快 `push`。
3. 如果知道对方也在改同一个文件，先在群里说一声，或者约定「这个文件这半天归我」。
4. 已经冲突了就走第 6 节，不要在冲突未解决时 `push` 或 `pull`。

### 5.5 明令禁止

| 禁止 | 原因 |
| --- | --- |
| `git push --force` / `--force-with-lease` 到 `main` | 会把别人已推的提交从远端抹掉，且对方本地看起来「凭空少东西」 |
| 没 `pull` 就直接 `push` | 大概率被拒（non-fast-forward）；为了推上去而 force，就是上一条 |
| `git commit -a` 一把梭 | 会把不相关的临时改动（`.mote-preview-*.html`、调试脚本）一起提交 |
| 在 `main` 上改完再长期不推 | 两边分叉越久，rebase 冲突越多 |

被拒（`! [rejected] main -> main (non-fast-forward)`）时的正确动作：

```powershell
git pull --rebase        # 把你的提交重放到 origin/main 之上
git push
```

---

## 6. 冲突的实际处理

### 6.1 先看清状态

```powershell
git pull --rebase
git status                                  # 会列出 "Unmerged paths"
git diff --name-only --diff-filter=U        # 只列冲突文件
```

### 6.2 文本冲突

打开冲突文件，会看到：

```
<<<<<<< HEAD
目录栏 cursor: default;
=======
目录栏整栏 cursor: pointer;
>>>>>>> 3f2a1c9 (目录栏改为手型)
```

编辑成你想要的最终内容（删掉三行标记），然后：

```powershell
git add resources/web/editor.css
git rebase --continue
```

多个文件就重复「编辑 → `git add` → `git rebase --continue`」。
想整段放弃这次 rebase、回到动手前：

```powershell
git rebase --abort
```

### 6.3 整文件取一边（rebase 语义是反的，别记错）

`git rebase` 期间 `HEAD` 是**上游**，你正在重放的提交才是 `theirs`：

| 命令 | rebase 时的含义 |
| --- | --- |
| `git checkout --ours -- <file>` | 取**远端/别人**的版本 |
| `git checkout --theirs -- <file>` | 取**你自己**这次提交的版本 |

merge（`git merge`/普通 `git pull`）时含义相反：`--ours` 是当前分支（你），`--theirs` 是被合进来的。
不确定时用 `git log --oneline -3 -- <file>` 和 `git diff <file>` 看清楚再选。

### 6.4 二进制冲突（图片、字体、图标）

`*.png` / `*.icns` / `*.ico` / `*.ttf` 在 `.gitattributes` 里是 `-text`，没法逐行合并：

```powershell
git checkout --theirs -- screenshots/theme-light.png   # 或 --ours，按你要保留谁
git add screenshots/theme-light.png
git rebase --continue
```

### 6.5 冲突解决后必须复验

```powershell
git status -sb                       # 干净、没有 "rebase in progress"
git log --oneline -3
git ls-files --eol tools/package/package_macos.sh tools/release/publish_windows.ps1   # 行尾没被弄坏
```

改了前端（`resources/web/*`）或 C++（`core/*`、`shell/*`）的话，在对应的平台上重新编译、跑一遍再推。

---

## 7. 和 Windows 编译的关系（只影响「能不能跑」，不影响「能不能同步」）

同步链路只需要 Git：clone 下来就能看代码、改文档、提交、推送。
`build/`、`dist/` 都被忽略，编译产物不会进仓库。

只有在 Windows 上要**运行/打包 Windows 版**时才需要 MSVC、CMake、WebView2 SDK 与
WebView2 Runtime；那套步骤在 [WINDOWS-FROM-MACOS.md](WINDOWS-FROM-MACOS.md) 和
[docs/windows-native-build-setup.md](../docs/windows-native-build-setup.md) 里。

对同步有实际影响的两点：

1. **前端资源在构建时拷进产物**，改 `resources/web/*` 后需要在各自平台重新构建才能看到效果；
   Mac 侧验证过的改动，Windows 侧不重新编译就不会体现——这不是同步问题，别误判成「没拉到代码」。
2. **`dist/` 不进仓库**，所以 Windows 需要的包必须在本机用 `package_windows.ps1` 重新打；
   不要把 `dist/Mote-macOS-native.zip` 拷过去用（里面是 arm64 的 `.app`）。

---

## 8. 这份文档的验证状态（如实说明）

- 编写与提交环境是 **macOS**，本机**没有 Windows 环境**，
  第 4 节的 `git ls-files --eol` 期望输出是在 Mac 上推导的属性规则，**未在 Windows 上实测**。
- 涉及 Gitee 侧的操作（SSH 公钥入口、443 端口 SSH、私人令牌权限名）以 Gitee 当前页面为准，
  这里只给路径不给截图。
