# Mote

**C++20 原生薄外壳 + 系统 WebView 的 Markdown 查看 / 编辑器：macOS 用 AppKit + WKWebView（发布包不含 Qt），Windows 用 Win32 + WebView2；正文的渲染与编辑交给系统 WebView，前端零框架、零构建，不引入 Electron 一类运行时。两端共用 `core/` 与同一份前端资源。**

## 功能

按当前实际已实现的能力（macOS 与 Windows 原生外壳均已实机验收，仍有 mac 对照等缺口，见 [阶段 B 验收记录](docs/thin-shell-stage-b-acceptance.md)；Windows 上快捷键把 `Cmd` 换成 `Ctrl`）：

- **所见即所得块编辑**：正文按空行切块，点击某块即就地显示该块的 Markdown 原文，其余块保持排版效果；离开该块后按原文重新渲染。
- **代码块**：围栏代码块带语法高亮（内置轻量高亮，无第三方解析/高亮库）、左侧行号与语言徽标；点击徽标可改语言。
- **表格与分隔线**：表格就地编辑（单元格、分隔行、对齐），分隔线可直接选中修改。
- **目录（TOC）**：由标题生成，点击跳转；`Cmd+Shift+L` 开关。
- **查找替换（`Cmd+F`）**：可跨块跳转；一个命中不会跨越块边界或行内标记，替换不会破坏标记结构——跨标记、含换行、表格里的 `|`、代码里的 ``` 等替换会被拒绝并在查找条上说明原因。
- **缩放**：`Cmd+=` / `Cmd+-` / `Cmd+0`。
- **源码模式**：`Cmd+E` 在渲染态与纯文本 Markdown 之间切换。
- **图片**：粘贴或拖入图片会落盘到 Markdown 同目录的 `assets/`，并插入相对路径；相对路径图片按文档所在目录解析。
- **新建**：`Cmd+N`；当前文档有未保存修改时先询问「保存 / 不保存 / 取消」。
- **快捷键与斜杠命令**：见下。
- **块类型转换**：右键任意块弹出「转为」，支持正文、标题 1–3、无序/有序列表、引用、代码块；多选可合并成一个列表。
- **任务列表**：`- [ ]` / `- [x]`（`*`、`+` 作列表符号、缩进子项同样支持）渲染成可点击复选框；点击即改写原文的 `[ ]`／`[x]`，一次撤销可还原。复选框不进入框选复制的文本，复制出去仍是标准 Markdown 任务列表；编辑态下任务标记是可见文本，可直接用键盘改。
- **字数统计**：状态栏右侧显示「中文 N 字 · 英文 M 词」。中文按 CJK 字符逐个计数（含扩展 A 区与兼容区），英文按「连续字母/数字算一个词、词内可含 `'`／`-`／`’`」计数；代码块正文计入、围栏与行号不计。
- **深色模式**：默认跟随系统外观（macOS 读 `NSApp.effectiveAppearance`，Windows 读注册表 `AppsUseLightTheme` 并响应 `WM_SETTINGCHANGE`），也可用「视图 → 深色模式」(`Cmd+Shift+D`) 手动切换；手动切换后可用「跟随系统外观」交回系统。切换只换配色，不改文档内容、块几何与编辑状态。
- **链接**：渲染态下 `[文字](地址)` 的文字显示为蓝色带下划线的链接（地址本身仍是零宽标记，不占位、不进入框选复制）；普通点击仍进入编辑态，`Cmd+Click` 才跳转——外部链接交给系统默认浏览器，相对路径的 `.md` 在应用内打开（走未保存确认），文件不存在时弹提示不崩。编辑态显示原始 `[文字](地址)`，复制出去是标准 Markdown。
- **导出 HTML**：`Option+Cmd+E`（「文件 → 导出 HTML…」）导出单文件自包含 HTML——样式内联、图片转 base64 内嵌、代码高亮与任务复选框状态保留，导出过程不改动原文档与 `dataset.raw`。
- **导出 PDF**：`Cmd+P`（「文件 → 导出 PDF…」）导出 A4 多页、无页眉页脚；源码模式下禁用。macOS 与 Windows 均已实现，两端分页切点由各自 WebView 引擎决定，未做逐页像素比对。
- **在线更新**：启动 10 秒后检查一次，之后每 24 小时一次；macOS 在「Mote → 检查更新…」、Windows 在「文件 → 检查更新…」可随时手动触发。两端共用 `core/update` 解析清单、比较版本、给出判定（已是最新 / 有新版本 / 当前系统过低），提示文案统一为中文。「发现新版本」弹窗显示版本号、发布时间、包大小，清单带可选 `notes_url` 时追加一行可点击的「查看完整更新说明…」。两端读同一份带 Ed25519 签名的 `manifest.json`：macOS 取 `platforms.macos`，用户确认后交给 Sparkle 下载 `artifacts.dmg`、验证 EdDSA 签名并替换重启；若处于 Gatekeeper App Translocation（隔离路径）只读路径，先提示把 Mote 移到「应用程序」再更新。Windows 取 `platforms.windows`，确认后应用内下载更新包，弹窗内显示百分比与「已下载 / 总大小」并可取消，失败自动重试最多 3 次（间隔 2 秒；4xx 与非法地址不重试），下载完用 SHA256 校验——安装版取 `artifacts.setup`（静默安装后自动重启），绿色版取 `artifacts.portable`（校验通过后打开所在文件夹，解压覆盖）。
- **页面内状态栏**：原生外壳把状态栏画在前端页面底部（`body.platform-mac` / `body.platform-win`），显示打开/保存/导出提示与字数统计。
- **目录手型光标**：鼠标移到目录栏（条目文字行、行间空隙、栏内空白）都是系统手型指针，避免移动时手型闪烁；折叠按钮与滚动条保留自身光标语义。

## 构建与运行（macOS）

依赖：

- macOS 14 及以上（Apple Silicon，arm64）；CMake 目标为 `-mmacosx-version-min=14.0`
- Xcode Command Line Tools
- CMake 3.25+

构建：

```bash
cmake -S native -B build-native
cmake --build build-native
ctest --test-dir build-native                    # core 单测，无需 GUI

open build-native/Mote.app                       # 或直接运行
./build-native/Mote.app/Contents/MacOS/Mote 文档.md
```

一键打包（构建 + Developer ID 签名 + 公证 + zip/DMG + 依赖自检）：

```bash
bash packaging/package_macos.sh --dmg
# 产物：dist/Mote-macOS-native.zip / dist/Mote-macOS-native-*.dmg
# 体积约 4.1 MB（.app，含 Sparkle.framework） / DMG 约 1.7 MB
```

**发布前有三层门禁（2026-11-19 起），杜绝 1.0.4 残缺 DMG 回归：**

| 层 | 位置 | 行为 |
|---|---|---|
| configure | CMakeLists.txt `-DMOTE_STRICT_BUILD=ON` | Sparkle.framework 缺失 → **FATAL_ERROR** |
| configure 自动修复 | CMakeLists.txt（macOS 分支） | Sparkle 2.x tarball 缺 `Versions/Current` 符号链接 → 自动探测并补建 |
| 打包脚本 | `package_macos.sh` | `.app/Contents/Frameworks/Sparkle.framework` 必须存在 + `.app ≥ 1024 KB` → exit 1 |
| 发布脚本 | `publish_macos.sh` | DMG 内同样双保险 |

Sparkle 2.x tarball（如 `Sparkle-2.7.0.tar.xz`）已知缺陷：顶层符号链接
`Sparkle -> Versions/Current/Sparkle` 存在，但 `Versions/Current` 本身缺失。
configure 阶段会自动探测 `Versions/` 下唯一子目录（如 `B`）并补建
`Current -> B`，**新机器 setup 不用再手动 `ln -sfn B Current`**——CMake 自动处理。

开发机本地开发如果没有 Sparkle，可以不加 `-DMOTE_STRICT_BUILD=ON`，configure
只会 WARNING 并继续；产物缺 framework 时应用内更新会退回浏览器下载。
**CI 和正式发布脚本一律传 `-DMOTE_STRICT_BUILD=ON`**。

`tools/preflight.sh` 可在干净构建后跑一次启动冒烟。

### Windows 原生外壳（默认发布路径）

需要 VS2022（C++ 桌面开发）、CMake ≥ 3.25、WebView2 SDK（`WEBVIEW2_SDK`）与 Evergreen Runtime。从零装机的完整步骤（Build Tools 组件 ID、静默安装、各项验证命令）见 [docs/windows-native-build-setup.md](docs/windows-native-build-setup.md)。

```bat
set WEBVIEW2_SDK=C:\dev\webview2sdk\pkg
cmake -S native -B build-native-win -A x64
cmake --build build-native-win --config Release
```

用 Ninja 时：`cmake -S native -B build-native-ninja -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build-native-ninja`，产物在 `build-native-ninja\`。

打包（产物 `dist/Mote-Windows/` 与 `dist/Mote-Windows.zip`，不含 Qt）：

```powershell
powershell -ExecutionPolicy Bypass -File packaging\package_windows_native.ps1
# 可选安装包（Inno Setup 6）：产物 dist\Mote-Setup-<版本>.exe
powershell -ExecutionPolicy Bypass -File packaging\build_installer.ps1
```

验收项、实测结论与仍未覆盖的项（干净机、IME 组词、mac 截图对照）见
[docs/thin-shell-stage-b-acceptance.md](docs/thin-shell-stage-b-acceptance.md)；
打包细节见 [packaging/PACKAGING.md](packaging/PACKAGING.md) 第 6 节。

快捷键说明：`Ctrl+Shift+S`（另存为）与 `Ctrl+Alt+E`（导出 HTML）会被 WebView2/Chromium 在浏览器层先消费，外壳用进程内低级键盘钩子提前截获，键位与 mac 侧保持一致（`Cmd` 对应 `Ctrl`）；其余 `Ctrl+S/O/P/…`、`Ctrl+Shift+L/D`、`Ctrl+/` 走 `AcceleratorKeyPressed` 分发。

### 发布与在线更新

产物托管在 `https://dl.xiaotu.online`（阿里云 OSS + CDN），key 固定：

| 用途 | OSS key |
| --- | --- |
| macOS 安装包 | `mote/mote-<version>-macos-arm64.dmg` |
| Sparkle feed（EdDSA 验签 + 下载） | `mote/updates/<channel>/appcast.xml` |
| 统一更新清单（两平台同一份，Ed25519 验签） | `mote/updates/<channel>/manifest.json` |
| 发布说明页（清单 `notes_url` 指向它） | `mote/release-notes-<version>.html` |
| Windows 绿色包（zip） | `mote/mote-<version>-win64-portable.zip` |
| Windows 安装包（exe，可选） | `mote/mote-<version>-win64-setup.exe` |

```bash
bash packaging/package_macos.sh --dmg   # 签名 + 公证 + DMG
bash tools/release/publish_macos.sh                  # 公证门禁 → EdDSA 签名 → appcast + manifest.json → 上传 → 线上校验
```

发布脚本会自动检测 `docs/release-notes-<版本>.html`：存在就上传到
`mote/release-notes-<版本>.html` 并写进清单 `notes_url`。要指向外部页面时再用
`NOTES_URL=https://... bash tools/release/publish_macos.sh` 覆盖（必须是绝对地址，
脚本不再自动上传）。

```powershell
powershell -ExecutionPolicy Bypass -File packaging\package_windows_native.ps1
powershell -ExecutionPolicy Bypass -File tools\release\publish_windows.ps1   # 校验 → SHA256 → manifest.json → 上传 zip/安装包/清单 → 线上校验
```

在 macOS 上发布 Windows 包时用等价的 bash 脚本（读同一份 `~/.config/xiaotu-updates/.env`）：

```bash
BUILD=<与 Windows 构建时 -DMOTE_BUILD 相同的值> \
  bash tools/release/publish_windows.sh              # 定位产物 → 清单 → 上传 → 线上校验
```

- 产物定位：绿色包默认取 `dist/Mote-<版本>-win64-portable.zip`，不存在时回落 `dist/Mote*.zip`；安装包自动找 `dist/*setup*.exe`（也可用 `ZIP_PATH` / `SETUP_PATH` 显式指定）。
- `BUILD` 必填，且必须等于 Windows 构建时的 `-DMOTE_BUILD`：清单 `build` 比安装包新会让客户端反复提示同一版本。
- 官网与下载页统一由 `web/` 维护：ECS 用 `deploy_site.sh` 发布，备案前的 OSS 镜像用 `publish_site_oss.sh` 发布。旧的单页 `site/index.html` 与 `publish_site.ps1` 已退役，`dl.xiaotu.online` 根路径只做跳转，不再承载页面。
- 版本号只改仓库根的 `VERSION.txt`（单行 `x.y.z`），各发布脚本与 CMake 都从那里读。
- 发布说明页：把 `docs/release-notes-<版本>.html` 放进仓库即可，macOS 与 Windows 发布脚本都会自动上传并写进清单 `notes_url`，客户端弹窗据此显示「查看完整更新说明…」。要指向外部页面时用 `NOTES_URL`（绝对地址）覆盖，此时脚本不再上传本地文件；缺页则不写该字段，老清单与老客户端都不受影响。已发布版本可用 `tools/release/manifest_v2.py resign --notes-url <地址>` 补发，无需重新打包。
- Sparkle 2 强制 EdDSA：私钥在发布机 `~/.config/mote-updates/`，公钥写进 `Info.plist` 的 `SUPublicEDKey`，都不随仓库分发。
- 检查权在自研模块（`SUEnableAutomaticChecks=false`）：Sparkle 只负责下载、验签、替换、重启。
- Windows 按安装形态取包：exe 同级有 `unins000.exe` 判为安装版，优先用 `platforms.windows.artifacts.setup`；否则用 `artifacts.portable` 的 zip；清单缺首选产物时回落到另一种。下载在应用内完成并校验 SHA256：安装版静默安装后自动重启，绿色版下载校验后提示、自动退出并打开所在文件夹，由用户解压覆盖。两条路径都会先检查未保存文档。
- `publish_windows.ps1` 会一并发布安装包（`dist\Mote-Setup-<版本>.exe` 存在时），并逐项校验线上 zip、安装包与清单三者一致。
- 两个平台共用一份 `manifest.json`：macOS 只取 `platforms.macos`（`artifacts.dmg`），Windows 只取 `platforms.windows`（`artifacts.setup` / `artifacts.portable`），不会把 `.dmg` 当成 Windows 包。

### 官网（xiaotu.online）

官网是 `web/` 下的多页静态站（首页、三款产品页、下载页、文档页、隐私页、404、sitemap 与 robots）。正式站托管在 ECS 的 nginx 上；备案未通过期间用独立的 OSS 桶 `xiaotu-site` 做镜像，走 `pre.xiaotu.online`：

```bash
bash tools/release/deploy_site.sh                    # rsync web/ → ECS:/var/www/xiaotu
bash tools/release/publish_site_oss.sh               # 同步 web/ → OSS 桶 xiaotu-site（pre 镜像）
bash packaging/renew_site_cert.sh                # 续期 pre 域名证书并更新到 OSS
SKIP_LINK_CHECK=1 bash tools/release/deploy_site.sh  # 跳过死链门禁（不推荐）
DEPLOY_HOST=user@host bash tools/release/deploy_site.sh
```

- 发布前做本地完整性检查（入口页、下载页、样式、脚本、图标）与死链门禁：页面里指向 `dl.xiaotu.online` 的下载链接必须全部 200，否则直接失败。
- 页面里的版本号、体积、SHA256 与下载地址由 `python3 tools/render_download.py` 从三份 `manifest.json` 渲染；发布前用 `--check` 比对，避免手抄值过期（站点脚本运行时也会做同样的校准，静态值只是兜底）。
- 同步用 `rsync -az --delete`，远端站点目录与 `web/` 完全一致；发布后校验入口页、下载页与静态资源都在。
- 服务器侧只需一次配置：deploy 用户公钥、`/var/www/xiaotu` 属主、nginx 站点（[packaging/nginx-xiaotu.conf](packaging/nginx-xiaotu.conf)）。
- 两个域名分工：`xiaotu.online` 放官网页面（`web/`），`dl.xiaotu.online` 放安装包、手册与更新清单（OSS），页面里的下载链接直接指向后者。
- OSS 镜像依赖桶级 `SupportSubDir=true`，否则 `/xiaotu/`、`/download/` 会回落到首页；`publish_site_oss.sh` 会自动写入该配置。
- `pre` 的证书由 `renew_site_cert.sh` 走 HTTP-01 续期（挑战文件写入 OSS 桶），本机由 `~/Library/LaunchAgents/online.xiaotu.site-cert.plist` 每月 1 日 04:17 触发。

## 快捷键

macOS 用 `Cmd`；Windows 把 `Cmd` 换成 `Ctrl`（`Option` 换成 `Alt`）。

| 分组 | 快捷键 | 作用 |
| --- | --- | --- |
| 文件 | `Cmd+N` / `Cmd+O` / `Cmd+S` / `Cmd+Shift+S` | 新建 / 打开 / 保存 / 另存为 |
| 文件 | `Option+Cmd+E` | 导出 HTML（自包含单文件） |
| 文件 | `Cmd+P` | 导出 PDF（A4 多页；源码模式下禁用） |
| 编辑 | `Cmd+Z` / `Cmd+Shift+Z` | 撤销 / 重做 |
| 编辑 | `Cmd+C` / `Cmd+X` / `Cmd+V` | 复制 / 剪切 / 粘贴 |
| 编辑 | `Cmd+F` | 查找替换条 |
| 格式 | `Cmd+B` / `Cmd+I` / `Cmd+K` / `Cmd+Shift+K` | 粗体 / 斜体 / 链接 / 行内代码（再按一次取消） |
| 格式 | `Cmd+1` / `Cmd+2` / `Cmd+3` | 标题 1/2/3（同级别再按回正文） |
| 格式 | `Cmd+Shift+8` / `Cmd+Shift+7` | 无序 / 有序列表 |
| 格式 | `Cmd+Shift+B` / `Cmd+Shift+C` / `Cmd+Shift+T` | 引用 / 代码块 / 表格 |
| 视图 | `Cmd+Shift+L` | 目录开关 |
| 视图 | `Cmd+E` | 源码模式 |
| 视图 | `Cmd+Shift+D` | 深色模式开关（手动切换会退出「跟随系统外观」） |
| 视图 | `Cmd+=` / `Cmd+-` / `Cmd+0` | 放大 / 缩小 / 实际大小 |

斜杠命令：行首输入 `/` 弹出命令面板，输入过滤，`↑`/`↓` 选择，`Enter` 插入，`Esc` 取消。
右键「转为」：正文、标题 1–3、无序/有序列表、引用、代码块。

## 已知限制

- **仅 arm64**：macOS 包只含 arm64 切片，Intel Mac 需自行重新构建。
- **发布包需 Developer ID + 公证**：正式产物由 `package_macos.sh` 签名并公证；跳过公证（`--skip-notarize`）的包只适合本机验证，不适合分发。
- **更新包强制 EdDSA 验签**：Sparkle 2 不接受只签 Developer ID 的更新包；签名私钥只在发布机上，丢失后无法为已发布版本续签。
- **macOS 包只依赖系统框架**：正式发布一律带 Sparkle.framework（`.app` 约 4.1 MB、DMG 约 1.7 MB），由 `MOTE_STRICT_BUILD=ON` + `package_macos.sh` / `publish_macos.sh` 三层门禁硬拦截缺 framework 的产物；WebKit 由系统提供。
- **源码模式无语法高亮**：`Cmd+E` 下是纯文本编辑区。
- **查找/替换不跨块**：可以在所有块之间跳转命中，但单个命中不会跨越块边界或行内标记。
- **上下方向键不跨块**：跨块移动光标需鼠标点击。
- **深色模式只覆盖正文区域**：网页侧（正文、标题、引用、表格、行内代码、代码块与语法高亮、目录、查找高亮、斜杠浮层）全部跟随主题；状态栏在深色下单独上色。菜单栏仍是系统原生外观，不随文档主题变化。
- **链接跳转**：`Cmd+Click` 外部链接（http/https/mailto）与相对路径的 `.md`；**锚点链接**（`#标题`）按 GitHub 风格的 slug 在文档内跳转（中文保留、去标点、空格转 `-`，重名标题依次加 `-1`、`-2`），未命中时状态栏提示「未找到对应标题」；**图片**按 `img` 渲染，没有 `<a>` 包裹，`Cmd+Click` 不触发任何跳转（相对路径图片仍按文档目录正常显示与导出内嵌）。
- **导出 HTML 是「网页快照」**：单文件、无外部依赖、无脚本；导出后不提供任何交互（链接仍可点，但任务复选框是静态图形）。
- **导出能力两端已对齐**：macOS 与 Windows 的 PDF、HTML 导出均已实现并验收；分页切点由各自 WebView 引擎决定。
- **更新链路的已知边界**：`0.3.5` 启动即崩，只能手动重新下载新版本；当前双平台均为 1.0.6（Windows build `202611191435`），更早的 `0.3.10`、`1.0.3`、`1.0.4` 的 OSS 包已清理，升级路径不再逐一冒烟；**1.0.4 的 macOS 包曾因缺 Sparkle.framework（DMG 750 KB）导致应用内更新退回浏览器下载**，该残缺包已从 OSS 删除，且 `MOTE_STRICT_BUILD=ON` + 打包/发布脚本三层门禁硬拦截缺 framework 的产物，后续不会再出现同类包；干净状态与带 quarantine 的首次安装已在 macOS 手工验证，但尚无自动化覆盖，断网/下载中断仍未验证（Windows 现在会对可重试错误自动重试 3 次）；Windows 安装版静默安装并自动重启，绿色版下载校验后提示、自动退出并打开所在目录，由用户解压覆盖。
- **OSS 在中国香港**：国内下载偏慢；备案完成后把回源迁到国内桶，`dl.xiaotu.online` 域名不变，已安装客户端无需改动。
- **任务复选框的复制**：复制处理器剔除隐藏标记；脚本用 `DataTransfer` 走产品同一条 `copy` 处理逻辑验证，真实 `Cmd+C` 写入系统剪贴板的最终结果仍需人工确认。
- 目录在源码模式下隐藏；正在编辑的块在重排前标题高亮可能滞后一帧。

## 目录结构

```
native/CMakeLists.txt    原生构建入口：读仓库根 VERSION.txt 的版本号，按平台生成 target
core/                    无平台 API 的共享核心
  json / base64 / paths  协议解析、图片解码、路径与 file:// 目录
  js_bridge              外壳 → 页面的脚本片段
  editor_controller      页面代次、ready 缓存、消息分发、脏标记
  image_store            assets/ 落盘与重名处理
  command_table          菜单唯一来源
  inject_chunks          大文档分片切分（UTF-8 安全）
  update                 更新清单解析、版本比较与升级判定（两端共用，不碰网络）
platform/mac/            AppKit + WKWebView：窗口、菜单、对话框、PDF/HTML、拖放、更新检查
platform/win/            Win32 + WebView2：窗口、菜单、对话框、拖放、PDF/HTML、更新检查
resources/
  web/                   前端编辑器（editor.html / editor.css / editor.js，唯一一份）
  fonts/                 JetBrains Mono（Light）与 OFL.txt
  icons/                 应用图标
  samples/               内置示例文档与示例图
  win/                   Windows 资源脚本（图标）
  Sparkle.framework      macOS 更新框架（构建时拷进 bundle，已 gitignore）
packaging/               打包脚本（macOS / Windows）、Inno Setup 配置、nginx 与证书续期脚本
tools/release/           发布脚本：清单生成与签名、双平台发布、官网同步、guard 校验
web/                     官网静态站（xiaotu.online 的唯一来源，deploy_site.sh 同步到 ECS）
icon-design/             应用图标设计稿与导出脚本（fonts/ 与 __pycache__/ 不入库）
docs/                    架构、设计与验收文档
screenshots/             文档引用的截图
VERSION.txt              版本号唯一来源（单行 x.y.z）
```

## 文档

- [docs/技术方案.md](docs/技术方案.md)：当前实际架构、在线更新方案、方案 A/B 取舍与实施状态
- [docs/Mote-用户手册.md](docs/Mote-用户手册.md)：面向使用者的完整手册（19 章，`packaging/tools/make_user_manual.py` 生成 PDF）
- [docs/发布工作流.md](docs/发布工作流.md)：从打包到 OSS 上线、补发说明页、凭据位置与验收命令
- [docs/OSS-发布布局.md](docs/OSS-发布布局.md)：三个产品在 OSS 上的对象布局、缓存策略与体积
- [docs/更新清单Schema-v2.md](docs/更新清单Schema-v2.md)：manifest.json 字段、验签规则与 `resign` 用法
- [docs/release-notes-1.0.4.html](docs/release-notes-1.0.4.html)：1.0.4 发布说明（Windows 编码识别、构建号修正；线上 `notes_url` 指向此页）
- [docs/release-notes-1.0.3.html](docs/release-notes-1.0.3.html) / [1.0.2](docs/release-notes-1.0.2.html) / [1.0.1](docs/release-notes-1.0.1.html) / [1.0.0](docs/release-notes-1.0.0.html)：1.0 各版发布说明
- [docs/release-notes-0.3.9.md](docs/release-notes-0.3.9.md) / [docs/release-notes-0.3.10.md](docs/release-notes-0.3.10.md)：0.3.x 近期版本发行说明（Windows 应用内更新、新图标）
- [docs/thin-shell-stage-a.md](docs/thin-shell-stage-a.md) / [docs/thin-shell-stage-b.md](docs/thin-shell-stage-b.md)：macOS / Windows 薄外壳设计与里程碑
- [docs/thin-shell-stage-a-acceptance.md](docs/thin-shell-stage-a-acceptance.md) / [docs/thin-shell-stage-b-acceptance.md](docs/thin-shell-stage-b-acceptance.md)：macOS / Windows 原生外壳验收记录
- [docs/windows-handoff-n1.md](docs/windows-handoff-n1.md)：Windows 实机验证交接单
- [packaging/PACKAGING.md](packaging/PACKAGING.md)：打包、产物、干净环境验证与逐项验收记录
- [docs/WEBVIEW-ARCHITECTURE.md](docs/WEBVIEW-ARCHITECTURE.md)：分层、消息协议、按键链路与前端块模型
- [docs/COLLAB.md](docs/COLLAB.md)：macOS + Windows 双机协作（clone、分工、冲突、Windows 环境）
- [tools/preflight.sh](tools/preflight.sh)：本机自检（仓库状态 → 独立目录构建 → macOS 启动冒烟）
- [docs/DECISIONS.md](docs/DECISIONS.md)：架构与交互的决策记录（接手前先读）
- [分支命名与归属](docs/DECISIONS.md#四分支命名与归属)：平台专属分支、共享层改动与跨平台提交的归属约定

## 第三方与许可

- **系统 WebKit**：macOS 自带框架，不随包分发。
- **WebView2 Runtime**：Windows 由系统/用户安装的 Evergreen Runtime 提供，不随包分发。
- **Sparkle 2**：macOS 自动更新框架，MIT 许可；`resources/Sparkle.framework`（不随仓库分发），构建时拷入 `.app/Contents/Frameworks/`。
- **JetBrains Mono**：SIL Open Font License 1.1；仓库内 [resources/fonts/OFL.txt](resources/fonts/OFL.txt)，
  发布包内 `licenses/JetBrainsMono-OFL.txt`。

## 许可证

Mote 以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布，完整条文见仓库根目录的 [LICENSE](LICENSE)。

自 v0.3.0 起采用 AGPL-3.0；更早的版本为 GPL-3.0，已发布版本的授权不受影响。
