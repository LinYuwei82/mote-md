# OSS 发布布局（安装包 / 更新清单 / 手册 / 官网）

> 更新日期：2026-11-28（末尾更新 2026-11-28：线上快照刷新为 Mote 1.0.33+30——修复分隔线插入崩溃、前端与原生代码按域分片重构、新增 122 条测试并接入 CI；同日清理 mote 1.0.5–1.0.32 共 82 个历史包 208 MB，`mote/` 仅保留当前版本。发布实操教训见《发布工作流》，CI stamp `/INCLUDE` 加固自 1.0.31 起持续验证「✓ 构建号一致」）
> **当前发布口径**：正式发布从 tag `v<semver>+<seq>` 触发，`build = seq`（从 1 起，无固定基数）；下面带日期的版本号与构建号是发布当时的快照，最新值以线上 `manifest.json` 为准。
> 数据来源：`oss://xiaotu-update`、`oss://xiaotu-site` 线上对象与元数据实测
> 适用仓库：`xiaotu-inventory`、`dev_card_cpp`、`mote`
>
> - 2026-11-19：按三份 `manifest.json` 与三份 `appcast.xml` 的引用为白名单清理过一次历史安装包
>   （v1 命名 27 个 + v2 旧版本 9 个，共 116 MB）。
> - 2026-11-28：Mote 1.0.33 发布后按同一白名单清理 `mote/`：删除 1.0.5–1.0.32 共 82 个对象、
>   约 208 MB，仅保留 1.0.33；1.0.32 的三个包已归档在 GitHub Release `v1.0.32+29`，需要时可回源。
> - 2026-11-28：三产品统一为「桶内只留当前版本」。本轮再删 xiaotu 1.0.26/1.0.27、
>   devcard 1.4.3/1.4.4 以及 devcard 遗留的孤立 `.edSignature`，共 30 个对象、约 55 MB；
>   旧版本均可在各自 GitHub Release 归档中取回。

## 一、总览：东西放在哪

| 位置 | 域名 | 放什么 | 不放什么 |
|---|---|---|---|
| OSS 桶 `xiaotu-update-sz`（深圳） | `https://dl.xiaotu.online` | 全部安装包（dmg/exe/zip）、自动更新清单、PDF 手册、发布说明、访问日志 | 网页、图片、CSS/JS |
| OSS 桶 `xiaotu-site-sz`（深圳） | `https://pre.xiaotu.online` | 官网静态网页（21 个文件） | 安装包、更新清单、PDF |
| ECS `/var/www/xiaotu` | `https://xiaotu.online` | 与 `xiaotu-site-sz` 完全相同的 21 个网页文件 | 安装包、更新清单 |

> 2026-11-26 备案通过后从香港迁移到深圳，域名与对象键完全不变；旧香港桶（`xiaotu-update` / `xiaotu-site`）已于当天验证深圳线路正常后清空删除。

一句话：**自动更新相关文件全部在 `xiaotu-update` 桶的 `<product>/updates/stable/` 下；安装包在 `<product>/` 根下；PDF 也在 `<product>/` 根下。** `<product>` 只有三个值：`devcard`、`xiaotu`、`mote`。

两个桶都已开启静态网站托管：

- 索引文档 `index.html`，错误文档 `404.html`
- `dl.xiaotu.online/` 的 `index.html` 是跳转到 `pre.xiaotu.online` 的过渡页
- 两个桶的 `index.html`、`404.html` 均为 `no-cache`

## 二、自动更新清单（核心）

> Schema v2 **已上线**（2026-11-18，见[更新清单Schema-v2](./更新清单Schema-v2.md)）：
> 每个产品一个 `manifest.json` 覆盖双平台，Ed25519 签名。
> v1 清单（`latest.json` / `windows.json`）已于 2026-11-18 全部删除（升级实测全绿后退役）。
> `appcast.xml`（Sparkle）不在 v2 范围，路径与格式不变。

三个产品的路径规则完全一致，只有产品目录不同：

| 产品 | 统一清单（v2） | Sparkle 清单 | v1 清单（已删除） |
|---|---|---|---|
| DevCard | `devcard/updates/stable/manifest.json` | `devcard/updates/stable/appcast.xml` | `latest.json`、`windows.json` |
| 小兔进销存 | `xiaotu/updates/stable/manifest.json` | `xiaotu/updates/stable/appcast.xml` | `latest.json`、`windows.json` |
| Mote | `mote/updates/stable/manifest.json` | `mote/updates/stable/appcast.xml` | `latest.json`、`windows.json` |

完整公网地址：

```
https://dl.xiaotu.online/<product>/updates/stable/manifest.json    # v2 统一清单
https://dl.xiaotu.online/<product>/updates/stable/appcast.xml      # Sparkle
```

线上实际元数据：

| 对象 | 大小 | Content-Type | Cache-Control |
|---|---|---|---|
| `devcard/updates/stable/manifest.json` | 1,373 B | `application/json; charset=utf-8` | `no-cache, max-age=60` |
| `devcard/updates/stable/appcast.xml` | 1,093 B | `application/xml; charset=utf-8` | `no-cache, max-age=60` |
| `xiaotu/updates/stable/manifest.json` | 1,452 B | `application/json` | `no-cache, max-age=60` |
| `xiaotu/updates/stable/appcast.xml` | 707 B | `application/rss+xml` | `no-cache, max-age=60` |
| `mote/updates/stable/manifest.json` | 1,391 B | `application/json` | `no-cache, max-age=60` |
| `mote/updates/stable/appcast.xml` | 776 B | `application/rss+xml` | `no-cache, max-age=60` |

> v1 清单（`latest.json` / `windows.json`）已删除，v2 清单与 appcast 是 updates/ 目录下仅有的内容。

> 清单统一 60 秒缓存，发布后最多 1 分钟生效。`appcast.xml` 的 Content-Type 小兔与 Mote 是 `application/rss+xml`、DevCard 是 `application/xml; charset=utf-8`（两个 json 也是 DevCard 带 charset），均能被 Sparkle 正常解析。
> 三个产品的清单与 appcast 现在都是 `no-cache, max-age=60`（DevCard 自 1.2.8 起对齐）。

## 三、安装包：dmg / exe / zip

所有安装包均为 `public, max-age=31536000, immutable`。`dl.xiaotu.online` 是 CNAME 直连、无 CDN 层，同名重传会替换源站对象，但客户端侧仍可能按 1 年缓存继续用旧字节，**正常发版必须换版本号**。仅在修复清单错误（如 2026-11-19 的 `build` 错位）而同版本重发时才允许覆盖同名对象，重发后必须核对线上 SHA256 已变化。

> 2026-11-19 清理过一次历史版本；2026-11-28 三产品统一清到只剩当前版本
> （Mote 82 个对象 208 MB；xiaotu/devcard 本轮再删 30 个对象 55 MB，含 devcard 孤立签名）。

### 3.1 DevCard（macOS 当前 1.4.5，Windows 当前 1.4.5）

当前版本（v2 命名，`dl.xiaotu.online/devcard/`，build 19，双平台同值；以线上清单为准）：

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `devcard/devcard-1.4.5-macos-arm64.dmg` | 6,030,386 | `application/octet-stream` |
| EXE | `devcard/devcard-1.4.5-win64-setup.exe` | 5,807,461 | `application/octet-stream` |
| ZIP | `devcard/devcard-1.4.5-win64-portable.zip` | 6,048,716 | `application/zip` |

> 1.4.5 已按 v2 正式发布；macOS 侧同时上传 `.edSignature`（89 B）。
> 桶内仅保留当前 1.4.5；1.2.6–1.4.4 的历史包与孤立签名已于 2026-11-28 清理，
> 需要回滚时从 GitHub Release 取回。
>
> DevCard Windows 构建号机制（2026-11-20 与小兔 / Mote 全链路对齐）：
> CMake configure 传 `-DDEVCARD_BUILD=<tag 序号>`，由
> `cmake/devcard_version.cmake` 的 `devcard_add_build_stamp(target)` 函数同时注入
> 两个宏：`DEVCARD_BUILD=<int>` 给 core 用、`DEVCARD_BUILD_STR="<int>"`
> 给 shell 的 BUILD_STR 拼接用（`shell/win/main.cpp` 里
> `kBuildStamp[] = "DEVCARD_BUILD=" DEVCARD_BUILD_STR`）。
> `compiled_build_number()` 条件编译返回注入值（未注入返回 0）；
> 服务端同版本时比较清单 `build` 与本地 `compiled_build_number()`；
> guard.py preflight 统一搜索二进制内 `"DEVCARD_BUILD=<digits>"` 静态字符串
> （三产品同口径，`_BUILD_STAMP_PREFIX` 映射已补齐）。
> 发布脚本（本地 `publish_windows.ps1 -Build N` 或 GitHub Actions）保证三端同值：
> CMake 注入 = 清单 build = 发布参数。
> macOS 段 build 与 Windows 同源（正式发布取 tag `v<semver>+<seq>` 的序号，两平台同值；`guard.py preflight`
> 校验同版本两平台 build 一致，单平台热修需 `--allow-build-drift`），
> 跨平台清单必须同时含 `platforms.macos` + `platforms.windows`（`guard.py preflight` 强制，缺失任一 die 拦截）。

### 3.2 小兔进销存（macOS 当前 1.0.28，Windows 当前 1.0.28）

当前版本（v2 命名，`dl.xiaotu.online/xiaotu/`，build 24，双平台同值；以线上清单为准）：

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `xiaotu/xiaotu-1.0.28-macos-arm64.dmg` | 6,438,438 | `application/octet-stream` |
| EXE | `xiaotu/xiaotu-1.0.28-win64-setup.exe` | 5,745,098 | `application/octet-stream` |
| ZIP | `xiaotu/xiaotu-1.0.28-win64-portable.zip` | 5,428,888 | `application/zip` |

> 1.0.28 已按 v2 发布，壳内地址为 `https://dl.xiaotu.online/xiaotu/updates/stable/manifest.json`。
> macOS 侧自 1.0.3 起按 `version` 判定更新（`build` 仅用于 Sparkle appcast、灰度分桶与诊断）；
> dmg 卷名自 1.0.2 起为英文 `Xiaotu Inventory`。
> 桶内仅保留当前 1.0.28；1.0.2–1.0.27 的历史包已于 2026-11-28 清理，
> 需要回滚时从 GitHub Release 取回。

### 3.3 Mote（macOS 当前 1.0.33，Windows 当前 1.0.33）

当前版本（v2 命名，`dl.xiaotu.online/mote/`，2026-11-28 发布 1.0.33+30）：

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `mote/mote-1.0.33-macos-arm64.dmg` | 3,218,500 | `application/octet-stream` |
| EXE | `mote/mote-1.0.33-win64-setup.exe` | 3,563,428 | `application/octet-stream` |
| ZIP | `mote/mote-1.0.33-win64-portable.zip` | 1,878,925 | `application/zip` |

> `build` 自 1.0.27 起统一为 tag 序号（1.0.33 = 30），双平台同值；macOS 客户端把编译期
> `MOTE_BUILD`（与 Info.plist `CFBundleVersion` 同源）传给更新判定：同版本重发按 build 区分，
> 口径与小兔 / DevCard 一致。
> Mote 的发布构建由脚本 / CI 显式传 `MOTE_RELEASE_BUILD=ON`（旧名 `MOTE_STRICT_BUILD` 仍兼容）：
> `resources/Sparkle.framework` 缺失时 FATAL_ERROR 硬拦截；Sparkle 2.x tarball 已知
> 缺陷（缺 `Versions/Current` 符号链接）由 configure 自动补建，新机器 setup 无需手动。
> 发布脚本（`package_macos.sh` / `publish_macos.sh`）各加一层硬门禁：
> `.app/Contents/Frameworks/Sparkle.framework` 必须存在 + `.app ≥ 1024 KB`，
> 缺任何一个 exit 1 不进入公证队列。1.0.4 的残缺 DMG（750 KB，缺 Sparkle）已于
> 2026-11-19 从 OSS 删除（连同 1.0.3 全套，共 8 个对象 10 MB）。
> 2026-11-28 又把 `mote/` 清到只剩 1.0.33：删除 1.0.5–1.0.32 共 82 个对象、约 208 MB；
> 1.0.32 全套归档在 GitHub Release `v1.0.32+29`，可回源。

## 四、PDF 手册与发布说明

| 对象键 | 大小（字节） | Content-Type | Cache-Control |
|---|---|---|---|
| `devcard/manual.pdf` | 19,652,641 | `application/pdf` | `public, max-age=86400` |
| `devcard/release-notes-1.4.5.html` | 2,380 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `xiaotu/manual.pdf` | 3,946,985 | `application/pdf` | `public, max-age=86400` |
| `xiaotu/release-notes-1.0.28.html` | 2,921 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `mote/manual.pdf` | 1,866,795 | `application/pdf` | `public, max-age=86400` |
| `mote/release-notes-1.0.33.html` | 2,120 | `text/html; charset=utf-8` | `public, max-age=3600` |

> 历史版本的说明页仍按版本保留：mote 28 份（1.0.0–1.0.33）、devcard 18 份（1.2.8–1.4.5）、
> xiaotu 22 份（1.0.3–1.0.28）。`mote/release-notes-1.0.4.html`、`xiaotu/release-notes-1.0.3.html`、
> `xiaotu/release-notes-1.0.2.html` 已于 2026-11-19 随 1.0.3 / 1.0.4 全套从 OSS 删除。
> 发布脚本（Mote / DevCard 的 `publish_macos.sh`、小兔的 `publish_macos.sh`）检测
> 仓库里的 `docs/release-notes-<版本>.html`，存在才一并上传并写入清单 `notes_url`；
> 缺 `.html` 则不写该字段。
>
> **notes_url 现状（2026-11-28）**：Mote 1.0.33、小兔 1.0.28 双平台均已写入；
> DevCard 1.4.5 仅 macOS 段有 `notes_url`，Windows 段缺（客户端在 `notes_url` 为空时
> 不显示「查看完整更新说明…」按钮）。补发说明页不必重新打包：
> `manifest_v2.py resign --notes-url <绝对地址>` 只改该字段
> 并整体重签（自动刷新 `updated_at`，产物字段原样保留），完整四步见
> [发布工作流 §9.1](./发布工作流.md)。清单因此会变大约 100 字节，属正常现象。
>
> 2026-11-28：三份 `manual.pdf` 的缓存头已用同键 CopyObject（`x-oss-metadata-directive: REPLACE`）
> 统一为 `public, max-age=86400`，内容与 ETag 未变（devcard/mote 原为 `no-cache, max-age=60`，xiaotu 原未设置）。

## 五、官网网页（`xiaotu-site` 桶 / ECS）

`xiaotu-site` 桶共 21 个对象，ECS `/var/www/xiaotu` 与之一一对应。

| 类型 | 对象键 | Cache-Control |
|---|---|---|
| 首页 | `index.html` | `no-cache` |
| 下载页 | `download/index.html` | `no-cache` |
| 小兔产品页 | `xiaotu/index.html` | `no-cache` |
| DevCard 产品页 | `devcard/index.html` | `no-cache` |
| Mote 产品页 | `mote/index.html` | `no-cache` |
| 文档页 | `docs/index.html` | `no-cache` |
| 关于页 | `about/index.html` | `no-cache` |
| 隐私页 | `privacy/index.html` | `no-cache` |
| 404 | `404.html` | `no-cache` |
| 样式 | `assets/css/site.css` | `public, max-age=604800` |
| 脚本 | `assets/js/site.js` | `public, max-age=604800` |
| 图标 | `assets/img/favicon.png` | `public, max-age=604800` |
| 图标 | `assets/img/apple-touch-icon.png` | `public, max-age=604800` |
| 产品图标 | `assets/img/icons/xiaotu.png` | `public, max-age=604800` |
| 产品图标 | `assets/img/icons/devcard.png` | `public, max-age=604800` |
| 产品图标 | `assets/img/icons/mote.png` | `public, max-age=604800` |
| 截图 | `assets/img/shots/xiaotu-products.jpg` | `public, max-age=604800` |
| 截图 | `assets/img/shots/devcard-assets.jpg` | `public, max-age=604800` |
| 截图 | `assets/img/shots/mote-editor.jpg` | `public, max-age=604800` |
| 爬虫 | `robots.txt` | `public, max-age=3600` |
| 站点地图 | `sitemap.xml` | `public, max-age=3600` |

公网地址：

```
https://pre.xiaotu.online/                  # OSS 深圳桶（测试/预览）
https://xiaotu.online/                      # ECS 正式站（已启用 HTTPS）
```

> 备案（粤ICP备2026190345，2026-11-25 通过）后 ECS 正式站已启用：DNS 指向
> `47.107.36.33`，`sudo certbot --nginx -d xiaotu.online -d www.xiaotu.online`
> 已签发证书（到期前自动续期），HTTP 自动 301 到 HTTPS。

下载页的版本号、大小、SHA256、下载链接由 `assets/js/site.js` 在浏览器里读取上面第二节的清单自动填充，**不需要手工改 HTML**。

## 六、哪个脚本上传哪个键

| 仓库 / 脚本 | 上传对象 |
|---|---|
| `xiaotu-inventory/tools/release/publish_macos.sh` | `xiaotu/xiaotu-<ver>-macos-arm64.dmg`、`xiaotu/updates/stable/manifest.json`、`xiaotu/updates/stable/appcast.xml`、`xiaotu/release-notes-<ver>.html`（存在时） |
| `xiaotu-inventory/tools/release/publish_windows.sh`（Mac 侧，遗留） | `xiaotu/xiaotu-<ver>-win64-setup.exe`、`xiaotu/xiaotu-<ver>-win64-portable.zip`、`xiaotu/updates/stable/manifest.json`、`xiaotu/release-notes-<ver>.html`（存在时） |
| `xiaotu-inventory/tools/release/publish_windows.ps1`（Windows 原生，自 2026-11-19 起推荐） | 同 `.sh`，Windows 构建机可直接执行，无需拷贝回 Mac。支持 `-Build`（自动从 CMakeCache 读）、`-SkipUpload`、`-NotesOnly` |
| `dev_card_cpp/tools/release/publish_macos.sh` | `devcard/devcard-<ver>-macos-arm64.dmg`（+ `.edSignature`）、`devcard/updates/stable/appcast.xml`、`devcard/updates/stable/manifest.json`、`devcard/release-notes-<ver>.html`（存在时） |
| `dev_card_cpp/tools/release/publish_windows.ps1` | `devcard/devcard-<ver>-win64-setup.exe`、`devcard/devcard-<ver>-win64-portable.zip`、`devcard/updates/stable/manifest.json`、`devcard/release-notes-<ver>.html`（存在时） |
| `mote/tools/release/publish_macos.sh` | `mote/mote-<ver>-macos-arm64.dmg`、`mote/updates/stable/appcast.xml`、`mote/updates/stable/manifest.json`、`mote/release-notes-<ver>.html`（存在时） |
| `mote/tools/release/publish_windows.sh`（或 `.ps1`） | `mote/mote-<ver>-win64-portable.zip`、`mote/mote-<ver>-win64-setup.exe`（存在时）、`mote/updates/stable/manifest.json`、`mote/release-notes-<ver>.html`（存在时） |
| `mote/tools/release/publish_site_oss.sh` | 本地 `web/` 的 21 个文件 → `xiaotu-site` 桶 |
| `mote/tools/release/deploy_site.sh` | 本地 `web/` 的 21 个文件 → ECS `/var/www/xiaotu` |
| 手工 | `<product>/manual.pdf`、README 等 |

> **小兔 Windows 发布路径选择**：2026-11-19 新增 `publish_windows.ps1` 后，Windows 构建机有两条路：
>
> - **选项 A**（推荐）：在 Windows 本机执行 `publish_windows.ps1`，需要签名私钥 PEM
>   （`~/.config/xiaotu-updates/update_signing_2026.pem` 或 CI 环境变量 `XIAOTU_UPDATE_SIGNING_KEY`）
> - **选项 B**（遗留）：把 setup.exe + zip 拷回 Mac，走 `publish_windows.sh`
>
> 两条路径功能等价，都走同一套 guard.py preflight / verify-live 门禁。
> 小兔仓库 `.github/workflows/release-windows.yml` 也已升级：打安装包后自动
> 部署 innounp（见 8.2），guard.py preflight 能正确从 setup.exe 里解包壳 EXE
> 做 BUILD_STR 二次校验。

## 七、缓存与 Content-Type 规则

| 对象类型 | Cache-Control | Content-Type |
|---|---|---|
| dmg / exe / zip | `public, max-age=31536000, immutable` | dmg/exe `application/octet-stream`，zip `application/zip` |
| manifest.json / appcast.xml | `no-cache, max-age=60` | `application/json` / `application/rss+xml`；DevCard 为 `application/json; charset=utf-8` / `application/xml; charset=utf-8` |
| `*.dmg.edSignature` | `public, max-age=300` | `text/plain; charset=utf-8` |
| manual.pdf | `public, max-age=86400` | `application/pdf` |
| release-notes-*.html | `public, max-age=3600` | `text/html; charset=utf-8` |
| 网页 HTML / 404 | `no-cache` | `text/html; charset=utf-8` |
| 网页 CSS / JS / 图片 | `public, max-age=604800` | 按扩展名 |
| logs/ | 无 | `application/octet-stream` |

## 八、发布命令

```bash
# 小兔
xiaotu-inventory/tools/release/publish_macos.sh          # macOS
xiaotu-inventory/tools/release/publish_windows.sh      # Windows

# DevCard（一条命令：出包 → 签名 → 公证 → 清单 → 上传）
dev_card_cpp/tools/release/publish_macos.sh
dev_card_cpp/tools/release/publish_windows.ps1         # Windows 机器上执行

# Mote
mote/tools/release/publish_macos.sh
mote/tools/release/publish_windows.sh
mote/tools/release/publish_windows.ps1                 # Windows 机器上执行

# 官网
bash mote/tools/release/publish_site_oss.sh            # → pre.xiaotu.online
bash mote/tools/release/deploy_site.sh                 # → xiaotu.online（ECS）

# Windows 也可走 GitHub Actions 发布（三仓库均有 release-windows.yml，手动触发）：
#   Actions → Windows 发布 → Run workflow（可选 dry_run 只出包不上传）
#   前置 secrets：OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET，以及清单签名种子/私钥：
#   小兔 XIAOTU_UPDATE_SIGNING_KEY（Ed25519 私钥 PEM）、
#   DevCard DEVCARD_UPDATE_SIGNING_KEY、Mote MOTE_UPDATE_SIGNING_KEY（32 字节种子 base64）。
```

### 统一门禁 `guard.py`

三个仓库各有一份**完全相同**的 `tools/release/guard.py`（Python 标准库，无第三方依赖），
发布脚本会在上传前自动调用 `preflight`、上传后自动调用 `verify-live`：

```bash
python3 tools/release/guard.py selftest      # CI 每次跑（50 项）
python3 tools/release/guard.py preflight --product xiaotu --kind mac --file <dmg>
python3 tools/release/guard.py verify-live --product xiaotu --kind win \
  --file <setup.exe> --zip <portable.zip>
```

它统一校验：产品/通道、文件名（**仅 v2 规则**，v1 命名已于 2026-11-18 全量删除）、版本单调、同名覆盖风险、清单字段与 SHA256、
线上 Content-Type，以及 dmg / 绿色包内嵌的更新地址。

#### Windows BUILD_STR 机制（2026-11-19 上线）

guard.py 在 v2 preflight 里新增了**二进制内 build 号二次校验**：
从绿色包 zip 或 setup.exe 里解包壳 EXE，搜 `XIAOTU_BUILD=<digits>` / `MOTE_BUILD=<digits>`
静态字符串，与命令行 `--build` 参数比对。不一致直接阻断发布。

| 组件 | 改动 |
|---|---|
| CMake 注入 | Mote：`native/CMakeLists.txt` 一处注入 `-DMOTE_BUILD=<int>` + `-DMOTE_BUILD_STR="<int>"` + `-DMOTE_BUILD_HASH=<短 commit>`；小兔：顶层只校验 `XIAOTU_BUILD` 必填，实际注入分散在 `shell/win/CMakeLists.txt` 给 updater、`core/CMakeLists.txt` 给 core；DevCard：`cmake/devcard_version.cmake` 的 `devcard_add_build_stamp(target)` 函数注入 `-DDEVCARD_BUILD=<int>` + `-DDEVCARD_BUILD_STR="<int>"`（双宏，整数宏给 core 用、字符串宏给 shell 拼接用） |
| 壳源码 | 三产品统一模式：`constexpr const char kBuildStamp[] = "<PREFIX>=" <PREFIX>_STR;` 进 .rdata 段。Mote `shell/win/updater_win.cpp`、小兔 `shell/win/updater_win.cpp`、DevCard `shell/win/main.cpp` 均已落地 |
| guard.py | `_BUILD_STAMP_PREFIX = {"mote": b"MOTE_BUILD=", "xiaotu": b"XIAOTU_BUILD=", "devcard": b"DEVCARD_BUILD="}`；`_read_exe_bytes` 解包 zip（绿色包）或用 innounp 解包 setup.exe（ISCC 安装包），搜对应前缀 |

zip 和 setup.exe 里的壳是**同一份编译产物**：两者同时存在时 guard.py 只扫 zip，setup.exe 那条跳过（`✓ setup.exe 同源于已校验的绿色包`）。只有 setup.exe 单独出现时才走 innounp 解包。

DevCard 2026-11-20 与小兔 / Mote 全链路对齐：guard.py 对三产品做相同的 BUILD_STR 二次校验，不再跳过。selftest 已覆盖 DevCard 正向用例（绿色包内 `DevCard.exe` 含 `DEVCARD_BUILD=<digits>`）。

#### innounp：解包 ISCC setup.exe

setup.exe 是 Inno Setup 6 压缩包，直接读字节找不到内部壳 EXE。
guard.py 用 **innounp**（Inno Setup 官方维护的解包程序）提取：

```bash
innounp -x -y "-d<临时目录>" <setup.exe>
# 临时目录里 rglob 找 xiaotu-shell.exe / Mote.exe
```

| 项 | 说明 |
|---|---|
| 原版 innounp 0.50 | innounp.sourceforge.net，支持 ISCC ≤ 6.1 |
| innounp-2 fork 2.70.1 | github.com/jrathlev/InnoUnpacker-Windows-GUI，支持 ISCC **6.7+**（当前版本） |
| 部署位置 | guard.py `_find_innounp()` 按顺序找：PATH → `~/.local-bin` → guard.py 同目录 → ISCC 安装目录 |
| CI 部署 | 小兔 / Mote 的 GitHub Actions `release-windows.yml` 在打安装包后自动下载到 `~/.local-bin` |

> **为什么不用 ISCC.exe 静默安装**：之前试过让 setup.exe `/VERYSILENT /DIR=<tmp>` 来自解压，
> 是个 hack（注册表里留痕迹、可能触发杀软、CI 无 GUI 子系统时可能卡住）。
> innounp 是正规解包工具，纯文件操作，干净无副作用。

改 `guard.py` 后必须用 `mote/tools/release/sync_guard.sh` 同步三份并更新各自的
`guard.sha256`；CI 会先执行 `sha256sum -c`，单仓库私自改动会直接失败。

```bash
bash mote/tools/release/sync_guard.sh              # 同步 guard.py + manifest_v2.py + .sha256
bash mote/tools/release/sync_guard.sh --local-only # 只跑 mote 本地 selftest + 重算 sha256
bash mote/tools/release/sync_guard.sh --check-build-str  # 检查三仓库 BUILD_STR 合规性
```

`--check-build-str` 会逐个验证：
1. CMake 配置是否含构建号注入（Mote / 小兔顶层 CMakeLists.txt 的 `XXX_BUILD_STR` 宏；DevCard `cmake/devcard_version.cmake` 的 `devcard_add_build_stamp()` 函数）
2. 壳源码是否含 `kBuildStamp[]` 静态字符串（Mote `shell/win/updater_win.cpp`、小兔 `shell/win/updater_win.cpp`、DevCard `shell/win/main.cpp`）
3. guard.py `_BUILD_STAMP_PREFIX` 映射是否与实现一致
DevCard 2026-11-20 起不再跳过，与另外两产品同口径检查。

#### UTF-8 BOM 三道闸（2026-11-20，三仓库同步上线）

PowerShell 5 在 Windows 上只读 UTF-8 + BOM（`\xef\xbb\xbf`）的 `.ps1`；无 BOM 的 UTF-8 会被当 GBK 读，中文字面量断裂导致脚本崩溃。三层防御：

| 层 | 文件 | 作用 |
|---|---|---|
| 检出时 | `.gitattributes`：`*.ps1 text eol=crlf working-tree-encoding=UTF-8` | 统一换行与编码声明（git 层面的软约束） |
| 提交时 | `tools/hooks/pre-commit`（bash） + `tools/hooks/setup-hooks.ps1` | 扫描所有 staged `.ps1`，前 3 字节不是 `EF BB BF` 直接阻断提交并给出修复命令；`git config core.hooksPath tools/hooks` 一次配置、持续生效 |
| 发布时 | `publish_windows.ps1`（三仓库） | 执行过程中遇到编码异常会主动报错，作为运行时兜底 |

> 核心约束：**仓库根 `.gitattributes`**（三仓库各一份）+ **tools/hooks/ 目录**（三仓库各一份，setup-hooks.ps1 含 UTF-8 BOM 自验证）。新机器首次 clone 后跑一次 `powershell -ExecutionPolicy Bypass -File tools/hooks/setup-hooks.ps1` 即可启用 pre-commit hook。

## 九、注意事项

1. **安装包是 `immutable`**：正常发版必须升版本号；只有修复清单错误而同版本重发时才覆盖同名对象（CNAME 直连、无 CDN，源站立即换字节），重发后核对 SHA256 已变化。`Cache-Control` 只影响客户端侧缓存。
2. **清单生效**：源站上传即生效；客户端可能因 `max-age=60` 缓存最多 1 分钟，验证时等 1 分钟或加时间戳。下载页版本号由 `site.js` 自动读取，无需改 HTML。
3. **发布脚本会校验产物**：Mote 校验 dmg 内 `SUFeedURL` 与 appcast 地址一致；guard（v2）校验绿色包内壳 exe 含当前 `manifest.json` 地址、清单 Ed25519 签名与产物 SHA256；不一致直接拒绝上传。
4. **三个产品已全部迁移到 v2**：当前线上版本 / 构建号以各自 `updates/stable/manifest.json` 为准；正式发布的 `build` 取 tag 序号（从 1 起，无固定基数），旧日期编号只保留在历史发布记录中。Mote 历史包已于 2026-11-28 清理到只剩 1.0.33（删除 82 个对象、约 208 MB；1.0.32 归档在 GitHub Release `v1.0.32+29`）；同日 xiaotu/devcard 也清到只留当前版本（再删 30 个对象、约 55 MB）。
5. **历史安装包已清零**：三产品桶内均只保留当前版本（Mote 1.0.33、xiaotu 1.0.28、devcard 1.4.5），旧版本可从各自 GitHub Release 归档取回；`manual.pdf`、`release-notes-*.html`、`manifest.json`、`appcast.xml` 长期保留。
6. `dl.xiaotu.online/logs/` 下是 OSS 每小时访问日志，属系统产出，不在发布范围内。
7. 桶根的 `devcard/`、`mote/`、`xiaotu/updates/` 等是控制台创建的 0 字节目录占位对象，可忽略。
