# 双机协作（macOS + Windows）

同一个仓库、同一份历史：Windows 侧**必须 `git clone` 本仓库**，不要另建独立仓库或复制目录后再 init。

```bash
git clone git@gitee.com:lin-yuwei168/mote-md.git
```

本机的机械检查交给 `tools/preflight.sh`（macOS）与 `tools/preflight.bat`（Windows），用法见文末。

## 1. 分支策略

- 两台机器都**不直接往 `main` 上写**。
- 各开短命分支，名字带平台与主题：`mac/base-dir`、`win/drop-target`、`docs/collab`。
- 一次只做一件事；验完**只合一条**回 `main`，合完即删分支。

## 2. 共享层约定

平台专属文件可以两边同时改：

- macOS：`src/macwebview.mm`、`src/macwebview.h`、`packaging/package_macos.sh`、`packaging/macos/*`
- Windows：`src/webview_win*.cpp`、`src/webview_win*.h`、`resources/win/app.rc`、`packaging/*.bat`、`packaging/*.ps1`

**共享处同一时间只允许一台机器改**：

- `src/webviewbase.*`、`src/webpage.*`
- `resources/web/*`（`editor.js` / `editor.css` / `editor.html`）
- `Mote.pro`
- 其它两端共用的外壳与接口：`src/webwindow.*`、`src/webview.h`、`src/main.cpp`

规矩：改之前先 `git pull`；这台机器把改动合入 `main` 之前，另一台不得动同一处。必须并行时先约定到文件级范围（例如一边只改 `editor.js` 的查找部分，另一边只改 CSS），避免同一文件双写。

## 3. 日常四步

```bash
# 1) 开工前：同步并看清状态
git pull --rebase && git status -sb

# 2) 干完一段：只加具体文件，推到自己的分支
git add <具体文件> && git commit && git push origin <分支>

# 3) 合入前：另一台先 pull 再合，验过再推 main
git pull --rebase
git checkout main && git merge --no-ff <分支> && git push origin main

# 4) 收工前：确认本机没有未提交改动
git status -sb
```

## 4. 硬规矩

- 仓库里**不用 `git push -f`**，不在 `main` 上 `git reset --hard`。
- 换机器前**不留未提交改动**：提交半成品（提交信息写清 WIP）或 `git stash`。
- 大改前打 `backup/<主题>-<日期>` 标签或分支，留一条可回退的路。
- 要发版才打 tag，且两台机器都编过才打。

## 5. 版本闸门

发版顺序固定，不跳步：

1. Mac 跑打包（`packaging/package_macos.sh`）；
2. Windows 跑打包；
3. 两个产物都成功；
4. 才在 `main` 上打 `vX.Y.Z` 并推；
5. 另一台 `git pull` 对齐。

版本号唯一来源是 `Mote.pro` 的 `VERSION`：`Info.plist` 的 `@FULL_VERSION@`、发行说明与 DMG 文件名都从它派生，不允许另写一份。

## 6. 已知事故记录

- **2026-11：Windows 侧的改动让 macOS 编译失败**——`src/macwebview.mm` 里一个匿名命名空间漏了闭合大括号。Windows 构建根本不编译这个文件，本机一路全绿；macOS 拉下来直接编译失败。教训：动跨平台共享层（`src/webviewbase.*`、`src/webpage.*`、`Mote.pro` 等）必须在两台机器上都编过，不能只看本机通过。`tools/preflight.*` 就是为这条准备的。

## 冲突处理（最简）

1. `git pull --rebase` 发现冲突，先看 `git status` 列出文件。
2. 文本冲突直接在编辑器里解决，保留双方意图；`.gitattributes` 已保证 PNG/ICNS/ICO/TTF 不做文本合并（冲突时取其中一版即可）。
3. `git add <文件>` → `git rebase --continue`；搞乱了用 `git rebase --abort` 回到起点。
4. 不要用 `git push --force` 覆盖远端 `main`。

## Windows 侧环境

- Qt 6.x（MSVC 2022 64-bit 或 MinGW 64-bit，与 Qt 套件一致）
- WebView2 SDK（`WEBVIEW2_SDK` 环境变量指向 NuGet 包解压目录；构建期需要头文件与 `WebView2Loader.dll`）
- WebView2 Runtime（Win10/11 通常已预装；缺失时从微软官网装 Evergreen Runtime）
- Git for Windows（自带 OpenSSH；把公钥加到 Gitee）
- 构建：`qmake Mote.pro && nmake`（MSVC）或 `mingw32-make`（MinGW）

## 注意

- **不要在 Windows 上另建仓库**；必须 clone 同一个 `mote-md`，否则历史与远程会分裂。
- 提交前 `git status` 复核，不要提交 `dist/`、`build*/`、`*.app`、`*.zip`、`Makefile`、`*.o`、`.DS_Store`。

## 本机自检脚本

macOS：

```bash
bash tools/preflight.sh              # 构建 + 启动冒烟
bash tools/preflight.sh --no-smoke   # 只构建
```

- 依次做：打印当前分支与未提交改动 → 在独立目录（默认 `/tmp/mote-preflight`，可用 `MOTE_PREFLIGHT_DIR` 覆盖）跑 `qmake6`（回退 `qmake`）+ `make -j` → 用项目自带的 `MOTE_EVAL` 钩子启动一次冒烟（超时自动退出），打印块数、图片数等指标。
- 失败时高亮第一条 `error:` 并以非 0 退出，完整日志留在构建目录的 `build.log`。

Windows：

```bat
tools\preflight.bat
```

- 依次做：打印当前分支与未提交改动 → `qmake` + `nmake`（回退 `mingw32-make`）→ 检查 errorlevel 与 `Mote.exe` 是否存在 → 提示手动启动验证。
- **未在 Windows 验证**：首次在 Windows 机器上跑通后，请把结论补回本节。
