# 双机协作（macOS + Windows）

同一个仓库、同一份历史：Windows 侧**必须 `git clone` 本仓库**，不要另建独立仓库或复制目录后再 init。

```bash
git clone git@gitee.com:lin-yuwei168/mote-md.git
```

## 日常流程

- 每天开工先 `git pull --rebase`，收工前确保已 push；小步提交，一次只做一件事。
- 提交前 `git status` 复核，不要提交 `dist/`、`build*/`、`*.app`、`*.zip`、`Makefile`、`*.o`、`.DS_Store`。
- 推送前跑一次本机构建（macOS：`qmake6 Mote.pro && make -j4`；Windows：Qt Creator 或 `qmake && nmake`）。
- 只在自己的分支上开发，合并回 `main` 前先 rebase 到最新 `main`。

## 分支命名

- `feat/<短描述>`：新功能，如 `feat/task-list`
- `fix/<短描述>`：缺陷修复，如 `fix/toc-scroll`
- `docs/<短描述>`：只改文档

## 分工：平台专属 vs 共享

平台专属，各自维护、互不改动：

- `src/macwebview.mm`、`src/webwindow.cpp` 中的 macOS 分支、`packaging/package_macos.sh`、`packaging/*.plist`
- `src/winwebview.cpp`、`resources/win/*.rc`、`packaging/*.bat`
- `docs/` 中各自平台的说明

共享文件，改动前先在群里说一声，避免两端同时改：

- `resources/web/editor.js`、`resources/web/editor.css`、`resources/web/editor.html`
- `src/webview.h`（接口变更要两端同步实现）
- `Mote.pro`、`README.md`

建议：前端（共享）改动集中在一台机器上做，另一台只拉取；必须并行时先约定改动范围（例如 A 只改 `editor.js` 的查找部分、B 只改 CSS）。

## 冲突处理（最简）

1. `git pull --rebase` 发现冲突，先看 `git status` 列出文件。
2. 文本冲突直接在编辑器里解决，保留双方意图；`.gitattributes` 已保证 PNG/ICNS/ICO/TTF 不做文本合并（冲突时取其中一版即可）。
3. `git add <文件>` → `git rebase --continue`；搞乱了用 `git rebase --abort` 回到起点。
4. 不要用 `git push --force` 覆盖远端 `main`。

## Windows 侧环境

- Qt 6.x（MSVC 2022 64-bit 或 MinGW 64-bit，与 Qt 套件一致）
- WebView2 Runtime（Win10/11 通常已预装；缺失时从微软官网装 Evergreen Runtime）
- Git for Windows（自带 OpenSSH；把公钥加到 Gitee）
- 构建：`qmake Mote.pro && nmake`（MSVC）或 `mingw32-make`（MinGW）

## 注意

- **不要在 Windows 上另建仓库**；必须 clone 同一个 `mote-md`，否则历史与远程会分裂。
- 当前 Windows 宿主层尚未实现：界面能打开，正文不渲染（见 `packaging/WINDOWS-FROM-MACOS.md`）。
