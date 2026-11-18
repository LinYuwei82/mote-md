# OSS 发布布局（安装包 / 更新清单 / 手册 / 官网）

> 更新日期：2026-11-19
> 数据来源：`oss://xiaotu-update`、`oss://xiaotu-site` 线上对象与元数据实测
> 适用仓库：`xiaotu-inventory`、`dev_card_cpp`、`mote`
>
> 2026-11-19：桶内历史安装包已全部清理（v1 命名 27 个 + v2 旧版本 9 个，共 116 MB），
> 现在每个产品只保留当前版本的 3 个包。清理以三份 `manifest.json` 与三份 `appcast.xml`
> 的引用为白名单，先校验零冲突再删除。

## 一、总览：东西放在哪

| 位置 | 域名 | 放什么 | 不放什么 |
|---|---|---|---|
| OSS 桶 `xiaotu-update`（香港） | `https://dl.xiaotu.online` | 全部安装包（dmg/exe/zip）、自动更新清单、PDF 手册、发布说明、访问日志 | 网页、图片、CSS/JS |
| OSS 桶 `xiaotu-site`（香港） | `https://pre.xiaotu.online` | 官网静态网页（21 个文件） | 安装包、更新清单、PDF |
| ECS `/var/www/xiaotu` | `https://xiaotu.online` | 与 `xiaotu-site` 完全相同的 21 个网页文件 | 安装包、更新清单 |

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
| `devcard/updates/stable/manifest.json` | 1,260 B | `application/json` | `no-cache, max-age=60` |
| `devcard/updates/stable/appcast.xml` | 1,099 B | `application/xml; charset=utf-8` | `public, max-age=60` |
| `xiaotu/updates/stable/manifest.json` | 1,253 B | `application/json` | `no-cache, max-age=60` |
| `xiaotu/updates/stable/appcast.xml` | 714 B | `application/rss+xml` | `no-cache, max-age=60` |
| `mote/updates/stable/manifest.json` | 1,278 B | `application/json` | `no-cache, max-age=60` |
| `mote/updates/stable/appcast.xml` | 834 B | `application/rss+xml` | `no-cache, max-age=60` |

> v1 清单（`latest.json` / `windows.json`）已删除，v2 清单与 appcast 是 updates/ 目录下仅有的内容。

> 清单统一 60 秒缓存，发布后最多 1 分钟生效。`appcast.xml` 的 Content-Type 两个产品是 `rss+xml`、DevCard 是 `xml`，均能被 Sparkle 正常解析。

## 三、安装包：dmg / exe / zip

所有安装包均为 `public, max-age=31536000, immutable`。`dl.xiaotu.online` 是 CNAME 直连、无 CDN 层，同名重传会替换源站对象，但客户端侧仍可能按 1 年缓存继续用旧字节，**正常发版必须换版本号**。仅在修复清单错误（如 2026-11-19 的 `build` 错位）而同版本重发时才允许覆盖同名对象，重发后必须核对线上 SHA256 已变化。

> 历史版本已于 2026-11-19 全部清理，每个产品只保留当前版本的 3 个包；需要回滚只能重新构建产物。

### 3.1 DevCard（macOS 当前 1.2.6，Windows 当前 1.2.6）

当前版本（v2 命名，`dl.xiaotu.online/devcard/`）：

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `devcard/devcard-1.2.6-macos-arm64.dmg` | 6,012,633 | `application/octet-stream` |
| EXE | `devcard/devcard-1.2.6-win64-setup.exe` | 5,820,685 | `application/octet-stream` |
| ZIP | `devcard/devcard-1.2.6-win64-portable.zip` | 6,130,765 | `application/zip` |

> 1.2.4 只发过 macOS、1.2.5 为过渡版本，二者均已于 2026-11-19 清理。

### 3.2 小兔进销存（macOS 当前 1.0.2，Windows 当前 1.0.2）

当前版本（v2 命名，`dl.xiaotu.online/xiaotu/`）：

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `xiaotu/xiaotu-1.0.2-macos-arm64.dmg` | 6,377,193 | `application/octet-stream` |
| EXE | `xiaotu/xiaotu-1.0.2-win64-setup.exe` | 3,691,741 | `application/octet-stream` |
| ZIP | `xiaotu/xiaotu-1.0.2-win64-portable.zip` | 2,423,867 | `application/zip` |

> Windows 1.0.2（build `202611190000`）与 macOS 1.0.2 均已按 v2 发布：
> 壳内地址为 `https://dl.xiaotu.online/xiaotu/updates/stable/manifest.json`，
> dmg 卷名自 1.0.2 起改用英文 `Xiaotu Inventory`（中文卷名在自动化环境
> 会被 TCC 拦截，见 `make_dmg.sh` 注释）。

### 3.3 Mote（macOS 当前 1.0.4，Windows 当前 1.0.4）

当前版本（v2 命名，`dl.xiaotu.online/mote/`）：

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `mote/mote-1.0.4-macos-arm64.dmg` | 750,328 | `application/octet-stream` |
| EXE | `mote/mote-1.0.4-win64-setup.exe` | 2,666,670 | `application/octet-stream` |
| ZIP | `mote/mote-1.0.4-win64-portable.zip` | 717,845 | `application/zip` |

> 2026-11-19 修复清单 `build` 错位（发布时刻 vs 编译时刻）后，1.0.4 按构建号一致重发；
> 重发会更新 EXE / ZIP 的字节数与 SHA256，以线上 `manifest.json` 为准。Windows 客户端
> 的同版本判定规则见[更新清单Schema-v2](./更新清单Schema-v2.md) 3.4。

## 四、PDF 手册与发布说明

| 对象键 | 大小（字节） | Content-Type | Cache-Control |
|---|---|---|---|
| `devcard/manual.pdf` | 5,563,312 | `application/pdf` | `public, max-age=86400` |
| `xiaotu/manual.pdf` | 3,702,580 | `application/pdf` | `public, max-age=86400` |
| `mote/manual.pdf` | 8,140,873 | `application/pdf` | `public, max-age=86400` |
| `mote/release-notes-1.0.3.html` | 4,639 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `mote/release-notes-1.0.2.html` | 5,664 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `mote/release-notes-1.0.1.html` | 7,453 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `mote/release-notes-1.0.0.html` | 9,184 | `text/html; charset=utf-8` | `public, max-age=3600` |

公网地址：

```
https://dl.xiaotu.online/devcard/manual.pdf
https://dl.xiaotu.online/xiaotu/manual.pdf
https://dl.xiaotu.online/mote/manual.pdf
https://dl.xiaotu.online/mote/release-notes-1.0.3.html
```

> 发布说明已随发布自动上传：`publish_windows.sh` / `.ps1` 检测到
> `docs/release-notes-<版本>.html` 就一并上传并写入 `notes_url`，缺页则不写该字段，
> 避免客户端出现死链。PDF 手册仍是手工上传。

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
https://pre.xiaotu.online/                  # OSS（测试/预览）
https://xiaotu.online/                      # ECS（备案中）
```

> 备案未通过前，阿里云会对 `Host: xiaotu.online` 的 80 端口请求返回
> `Non-compliance ICP Filing` 拦截页（403）；此时可用 `curl -H 'Host: IP'` 或直接
> `http://47.107.36.33/` 预览，页面内容与 `pre.xiaotu.online` 完全一致。
> 备案通过后执行 `sudo certbot --nginx -d xiaotu.online -d www.xiaotu.online` 并把
> DNS 指向 `47.107.36.33` 即可对外服务。

下载页的版本号、大小、SHA256、下载链接由 `assets/js/site.js` 在浏览器里读取上面第二节的清单自动填充，**不需要手工改 HTML**。

## 六、哪个脚本上传哪个键

| 仓库 / 脚本 | 上传对象 |
|---|---|
| `xiaotu-inventory/tools/package/publish_oss.sh` | `xiaotu/xiaotu-<ver>-macos-arm64.dmg`、`xiaotu/updates/stable/manifest.json`、`xiaotu/updates/stable/appcast.xml` |
| `xiaotu-inventory/tools/package/publish_windows.sh` | `xiaotu/xiaotu-<ver>-win64-setup.exe`、`xiaotu/xiaotu-<ver>-win64-portable.zip`、`xiaotu/updates/stable/manifest.json` |
| `dev_card_cpp/tools/release/publish_macos.sh` | `devcard/devcard-<ver>-macos-arm64.dmg`（+ `.edSignature`）、`devcard/updates/stable/appcast.xml`、`devcard/updates/stable/manifest.json` |
| `dev_card_cpp/tools/release/publish_windows.ps1` | `devcard/devcard-<ver>-win64-setup.exe`、`devcard/devcard-<ver>-win64-portable.zip`、`devcard/updates/stable/manifest.json` |
| `mote/tools/release/publish_macos.sh` | `mote/mote-<ver>-macos-arm64.dmg`、`mote/updates/stable/appcast.xml`、`mote/updates/stable/manifest.json` |
| `mote/tools/release/publish_windows.sh`（或 `.ps1`） | `mote/mote-<ver>-win64-portable.zip`、`mote/mote-<ver>-win64-setup.exe`、`mote/updates/stable/manifest.json` |
| `mote/tools/release/publish_site_oss.sh` | 本地 `web/` 的 21 个文件 → `xiaotu-site` 桶 |
| `mote/tools/release/deploy_site.sh` | 本地 `web/` 的 21 个文件 → ECS `/var/www/xiaotu` |
| 手工 | `<product>/manual.pdf`、README 等 |

## 七、缓存与 Content-Type 规则

| 对象类型 | Cache-Control | Content-Type |
|---|---|---|
| dmg / exe / zip | `public, max-age=31536000, immutable` | dmg/exe `application/octet-stream`，zip `application/zip` |
| manifest.json / appcast.xml | `no-cache, max-age=60` | `application/json` / `application/rss+xml`（DevCard 为 `application/xml`） |
| `*.dmg.edSignature` | `public, max-age=300` | `text/plain; charset=utf-8` |
| manual.pdf | `public, max-age=86400` | `application/pdf` |
| release-notes-*.html | `public, max-age=3600` | `text/html; charset=utf-8` |
| 网页 HTML / 404 | `no-cache` | `text/html; charset=utf-8` |
| 网页 CSS / JS / 图片 | `public, max-age=604800` | 按扩展名 |
| logs/ | 无 | `application/octet-stream` |

## 八、发布命令

```bash
# 小兔
xiaotu-inventory/tools/package/publish_oss.sh          # macOS
xiaotu-inventory/tools/package/publish_windows.sh      # Windows

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
python3 tools/release/guard.py selftest      # CI 每次跑
python3 tools/release/guard.py preflight --product xiaotu --kind mac --file <dmg>
python3 tools/release/guard.py verify-live --product xiaotu --kind win \
  --file <setup.exe> --zip <portable.zip>
```

它统一校验：产品/通道、文件名、版本单调、同名覆盖风险、清单字段与 SHA256、
线上 Content-Type，以及 dmg / 绿色包内嵌的更新地址。DevCard 与小兔的 CI
都有 `release-guard` 作业，阻止规则被改坏。

改 `guard.py` 后必须用 `mote/tools/release/sync_guard.sh` 同步三份并更新各自的
`guard.sha256`；CI 会先执行 `sha256sum -c`，单仓库私自改动会直接失败。

## 九、注意事项

1. **安装包是 `immutable`**：正常发版必须升版本号；只有修复清单错误而同版本重发时才覆盖同名对象（CNAME 直连、无 CDN，源站立即换字节），重发后核对 SHA256 已变化。`Cache-Control` 只影响客户端侧缓存。
2. **清单生效**：源站上传即生效；客户端可能因 `max-age=60` 缓存最多 1 分钟，验证时等 1 分钟或加时间戳。下载页版本号由 `site.js` 自动读取，无需改 HTML。
3. **发布脚本会校验产物**：Mote 校验 dmg 内 `SUFeedURL` 与 appcast 地址一致；guard（v2）校验绿色包内壳 exe 含当前 `manifest.json` 地址、清单 Ed25519 签名与产物 SHA256；不一致直接拒绝上传。
4. **三个产品已全部迁移到 v2**：当前版本 mote 1.0.4、xiaotu 1.0.2、devcard 1.2.6（macOS + Windows 双平台）。
5. **历史安装包已清零**：桶内只有当前 9 个包，`manual.pdf`、`release-notes-*.html`、`manifest.json`、`appcast.xml` 长期保留。
6. `dl.xiaotu.online/logs/` 下是 OSS 每小时访问日志，属系统产出，不在发布范围内。
7. 桶根的 `devcard/`、`mote/`、`xiaotu/updates/` 等是控制台创建的 0 字节目录占位对象，可忽略。
