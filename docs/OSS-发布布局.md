# OSS 发布布局（安装包 / 更新清单 / 手册 / 官网）

> 更新日期：2026-11-18
> 数据来源：`oss://xiaotu-update`、`oss://xiaotu-site` 线上对象与元数据实测
> 适用仓库：`xiaotu-inventory`、`dev_card_cpp`、`mote`

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

三个产品的路径规则完全一致，只有产品目录不同：

| 产品 | macOS 清单（自研客户端） | Sparkle 清单 | Windows 清单 |
|---|---|---|---|
| DevCard | `devcard/updates/stable/latest.json` | `devcard/updates/stable/appcast.xml` | `devcard/updates/stable/windows.json` |
| 小兔进销存 | `xiaotu/updates/stable/latest.json` | `xiaotu/updates/stable/appcast.xml` | `xiaotu/updates/stable/windows.json` |
| Mote | `mote/updates/stable/latest.json` | `mote/updates/stable/appcast.xml` | `mote/updates/stable/windows.json` |

完整公网地址：

```
https://dl.xiaotu.online/devcard/updates/stable/latest.json
https://dl.xiaotu.online/devcard/updates/stable/appcast.xml
https://dl.xiaotu.online/devcard/updates/stable/windows.json

https://dl.xiaotu.online/xiaotu/updates/stable/latest.json
https://dl.xiaotu.online/xiaotu/updates/stable/appcast.xml
https://dl.xiaotu.online/xiaotu/updates/stable/windows.json

https://dl.xiaotu.online/mote/updates/stable/latest.json
https://dl.xiaotu.online/mote/updates/stable/appcast.xml
https://dl.xiaotu.online/mote/updates/stable/windows.json
```

线上实际元数据：

| 对象 | 大小 | Content-Type | Cache-Control |
|---|---|---|---|
| `devcard/updates/stable/appcast.xml` | 1,269 B | `application/xml; charset=utf-8` | `public, max-age=60` |
| `devcard/updates/stable/latest.json` | 866 B | `application/json; charset=utf-8` | `public, max-age=60` |
| `devcard/updates/stable/windows.json` | 851 B | `application/json; charset=utf-8` | `public, max-age=60` |
| `xiaotu/updates/stable/appcast.xml` | 710 B | `application/rss+xml` | `no-cache, max-age=60` |
| `xiaotu/updates/stable/latest.json` | 681 B | `application/json` | `no-cache, max-age=60` |
| `xiaotu/updates/stable/windows.json` | 900 B | `application/json` | `no-cache, max-age=60` |
| `mote/updates/stable/appcast.xml` | 777 B | `application/rss+xml` | `no-cache, max-age=60` |
| `mote/updates/stable/latest.json` | 256 B | `application/json` | `no-cache, max-age=60` |
| `mote/updates/stable/windows.json` | 521 B | `application/json` | `no-cache, max-age=60` |

> 清单统一 60 秒缓存，发布后最多 1 分钟生效。`appcast.xml` 的 Content-Type 两个产品是 `rss+xml`、DevCard 是 `xml`，均能被 Sparkle 正常解析。

## 三、安装包：dmg / exe / zip

所有安装包均为 `public, max-age=31536000, immutable`，**同名文件覆盖不会生效，发新版必须换版本号**。

### 3.1 DevCard（macOS 当前 1.2.4，Windows 当前 1.2.5）

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `devcard/DevCard-1.2.4-macos-arm64.dmg` | 5,978,158 | `application/octet-stream` |
| 验签 | `devcard/DevCard-1.2.4-macos-arm64.dmg.edSignature` | 89 | `text/plain; charset=utf-8` |
| DMG | `devcard/DevCard-1.2.3-macos-arm64.dmg` | 5,977,010 | `application/octet-stream` |
| 验签 | `devcard/DevCard-1.2.3-macos-arm64.dmg.edSignature` | 89 | `text/plain; charset=utf-8` |
| DMG | `devcard/DevCard-1.2.2-macos-arm64.dmg` | 5,969,510 | `application/octet-stream` |
| 验签 | `devcard/DevCard-1.2.2-macos-arm64.dmg.edSignature` | 89 | `text/plain; charset=utf-8` |
| DMG | `devcard/DevCard-1.2.1-macos-arm64.dmg` | 5,924,494 | `application/octet-stream` |
| 验签 | `devcard/DevCard-1.2.1-macos-arm64.dmg.edSignature` | 89 | `text/plain; charset=utf-8` |
| DMG | `devcard/DevCard-1.2.0-macos-arm64.dmg` | 4,790,698 | `application/octet-stream` |
| 验签 | `devcard/DevCard-1.2.0-macos-arm64.dmg.edSignature` | 89 | `text/plain; charset=utf-8` |
| EXE | `devcard/DevCard-1.2.5-setup.exe` | 5,797,259 | `application/octet-stream` |
| EXE | `devcard/DevCard-1.2.3-setup.exe` | 5,794,245 | `application/octet-stream` |
| EXE | `devcard/DevCard-1.2.2-setup.exe` | 5,781,239 | `application/octet-stream` |
| EXE | `devcard/DevCard-1.2.1-setup.exe` | 5,818,875 | `application/octet-stream` |
| EXE | `devcard/DevCard-1.2.0-setup.exe` | 5,654,984 | `application/octet-stream` |
| ZIP | `devcard/DevCard-1.2.5-win64-portable.zip` | 6,088,677 | `application/zip` |
| ZIP | `devcard/DevCard-1.2.3-win64-portable.zip` | 6,088,675 | `application/zip` |
| ZIP | `devcard/DevCard-1.2.2-win64-portable.zip` | 5,984,916 | `application/zip` |
| ZIP | `devcard/DevCard-1.2.1-win64-portable.zip` | 6,033,802 | `application/zip` |
| ZIP | `devcard/DevCard-1.2.0-win64-portable.zip` | 5,750,450 | `application/zip` |

> 1.2.4 只发过 macOS（修复 Sparkle feed 地址）；Windows 侧 1.2.4 的两个包曾被 CI 误覆盖，
> 现以 **1.2.5** 为 Windows 最新版，清单已指向 1.2.5。

### 3.2 小兔进销存（macOS 当前 1.0.0，Windows 当前 1.0.1）

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `xiaotu/xiaotu-inventory-1.0.0.dmg` | 6,378,546 | `application/octet-stream` |
| DMG | `xiaotu/xiaotu-inventory-0.9.0.dmg` | 6,633,958 | `application/octet-stream` |
| EXE | `xiaotu/xiaotu-inventory-1.0.1-win64-setup.exe` | 3,692,653 | `application/octet-stream` |
| ZIP | `xiaotu/xiaotu-inventory-1.0.1-win64.zip` | 2,434,029 | `application/zip` |
| EXE | `xiaotu/xiaotu-inventory-0.9.0-win64-setup.exe` | 3,580,457 | `application/octet-stream` |
| ZIP | `xiaotu/xiaotu-inventory-0.9.0-win64.zip` | 2,137,094 | `application/zip` |

> Windows 1.0.1（build `202611180530`）已在本地 Windows 构建、Mac 发布，
> 壳内地址为 `https://dl.xiaotu.online/xiaotu/updates/stable/windows.json`，
> `windows.json` 已指向该版本。规则名 1.0.0 的 Windows 包（setup + zip）已删除；
> 1.0.0 的 **dmg 保留**，因为 macOS `latest.json` 仍指向它。
> macOS 尚未发 1.0.1，升版时请一并重打 dmg 并保留旧 dmg 直到清单切换。

### 3.3 Mote（macOS 当前 1.0.1，Windows 当前 1.0.2）

| 类型 | 对象键 | 大小（字节） | Content-Type |
|---|---|---|---|
| DMG | `mote/Mote-macOS-native-1.0.1.dmg` | 1,794,986 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-1.0.0.dmg` | 1,794,731 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.11.dmg` | 1,794,616 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.10.dmg` | 1,794,810 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.9.dmg` | 1,665,137 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.8.dmg` | 1,666,137 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.7.dmg` | 1,665,702 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.6.dmg` | 1,665,531 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.5.dmg` | 1,655,459 | `application/octet-stream` |
| DMG | `mote/Mote-macOS-native-0.3.4.dmg` | 580,303 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-1.0.2.exe` | 2,655,925 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-1.0.1.exe` | 2,650,735 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-1.0.0.exe` | 2,645,781 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-0.3.11.exe` | 2,646,030 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-0.3.10.exe` | 2,645,107 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-0.3.9.exe` | 2,566,713 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-0.3.8.exe` | 2,561,701 | `application/octet-stream` |
| EXE | `mote/Mote-Setup-0.3.7.exe` | 2,561,252 | `application/octet-stream` |
| ZIP | `mote/Mote-1.0.2-win64-portable.zip` | 702,247 | `application/zip` |
| ZIP | `mote/Mote-1.0.1-win64-portable.zip` | 677,418 | `application/zip` |
| ZIP | `mote/Mote-1.0.0-win64-portable.zip` | 670,738 | `application/zip` |
| ZIP | `mote/Mote-0.3.11-win64-portable.zip` | 670,714 | `application/zip` |
| ZIP | `mote/Mote-0.3.10-win64-portable.zip` | 669,542 | `application/zip` |
| ZIP | `mote/Mote-0.3.9-win64-portable.zip` | 637,679 | `application/zip` |
| ZIP | `mote/Mote-0.3.8-win64-portable.zip` | 630,129 | `application/zip` |
| ZIP | `mote/Mote-0.3.7-win64-portable.zip` | 628,975 | `application/zip` |

## 四、PDF 手册与发布说明

| 对象键 | 大小（字节） | Content-Type | Cache-Control |
|---|---|---|---|
| `devcard/manual.pdf` | 5,563,312 | `application/pdf` | `public, max-age=86400` |
| `xiaotu/manual.pdf` | 3,702,580 | `application/pdf` | `public, max-age=86400` |
| `mote/manual.pdf` | 8,140,873 | `application/pdf` | `public, max-age=86400` |
| `mote/release-notes-1.0.2.html` | 5,668 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `mote/release-notes-1.0.1.html` | 7,457 | `text/html; charset=utf-8` | `public, max-age=3600` |
| `mote/release-notes-1.0.0.html` | 9,271 | `text/html; charset=utf-8` | `public, max-age=3600` |

公网地址：

```
https://dl.xiaotu.online/devcard/manual.pdf
https://dl.xiaotu.online/xiaotu/manual.pdf
https://dl.xiaotu.online/mote/manual.pdf
https://dl.xiaotu.online/mote/release-notes-1.0.2.html
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

下载页的版本号、大小、SHA256、下载链接由 `assets/js/site.js` 在浏览器里读取上面第二节的清单自动填充，**不需要手工改 HTML**。

## 六、哪个脚本上传哪个键

| 仓库 / 脚本 | 上传对象 |
|---|---|
| `xiaotu-inventory/tools/package/publish_oss.sh` | `xiaotu/<dmg>`、`xiaotu/updates/stable/latest.json`、`xiaotu/updates/stable/appcast.xml` |
| `xiaotu-inventory/tools/package/publish_windows.sh` | `xiaotu/<setup.exe>`、`xiaotu/<win64.zip>`、`xiaotu/updates/stable/windows.json` |
| `dev_card_cpp/tools/release/publish_macos.sh` | `devcard/<dmg>`、`devcard/<dmg>.edSignature`、`devcard/updates/stable/appcast.xml`、`devcard/updates/stable/latest.json` |
| `dev_card_cpp/tools/release/publish_windows.ps1` | `devcard/<setup.exe>`、`devcard/<win64-portable.zip>`、`devcard/updates/stable/windows.json` |
| `mote/tools/release/publish_macos.sh` | `mote/<dmg>`、`mote/updates/stable/appcast.xml`、`mote/updates/stable/latest.json` |
| `mote/tools/release/publish_windows.sh`（或 `.ps1`） | `mote/Mote-<版本>-win64-portable.zip`、`mote/Mote-Setup-<版本>.exe`、`mote/updates/stable/windows.json` |
| `mote/tools/release/publish_site_oss.sh` | 本地 `web/` 的 21 个文件 → `xiaotu-site` 桶 |
| `mote/tools/release/deploy_site.sh` | 本地 `web/` 的 21 个文件 → ECS `/var/www/xiaotu` |
| 手工 | `<product>/manual.pdf`、README 等 |

## 七、缓存与 Content-Type 规则

| 对象类型 | Cache-Control | Content-Type |
|---|---|---|
| dmg / exe / zip | `public, max-age=31536000, immutable` | dmg/exe `application/octet-stream`，zip `application/zip` |
| appcast.xml / latest.json / windows.json | `no-cache, max-age=60` | `application/json` / `application/xml`（Mote、小兔为 `rss+xml`） |
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
#   前置 secrets：OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET；
#   小兔另需 XIAOTU_UPDATE_SIGNING_KEY（Ed25519 私钥 PEM）。
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

1. **安装包是 `immutable`**：同名覆盖不会生效，换内容必须升版本号；只改清单不换包会被 CDN 继续返回旧文件。
2. **清单 60 秒生效**：发布后等 1 分钟再验证；下载页版本号由 `site.js` 自动读取，无需改 HTML。
3. **发布脚本会校验产物**：Mote 校验 dmg 内 `SUFeedURL` 与 appcast 地址一致；小兔校验绿色包内 `xiaotu-shell.exe` 含当前 `windows.json` 地址；不一致直接拒绝上传。
4. **DevCard Windows 当前 1.2.5**，macOS 当前 1.2.4（Windows 侧 1.2.4 的包曾被 CI 覆盖，已用 1.2.5 重新发布）。
5. **小兔 Windows 1.0.0 包待重打**：壳内地址为旧路径；仓库已升到 1.0.1，待通过 `release-windows.yml` 发布（私有仓库需先修 Actions 额度/账单）。
6. `dl.xiaotu.online/logs/` 下是 OSS 每小时访问日志，属系统产出，不在发布范围内。
7. 桶根的 `devcard/`、`mote/`、`xiaotu/updates/` 等是控制台创建的 0 字节目录占位对象，可忽略。
