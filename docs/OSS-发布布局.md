# OSS 发布布局（安装包 / 清单 / 手册）

> 更新日期：2026-11-18
> 数据来源：`oss://xiaotu-update` 线上对象清单（86 个对象）

## 一、桶与站点

| 位置 | 域名 | 内容 |
|---|---|---|
| OSS 桶 `xiaotu-update`（香港） | `dl.xiaotu.online` | 安装包、更新清单、手册、发布说明、日志 |
| OSS 桶 `xiaotu-site`（香港） | `pre.xiaotu.online` | 仅网页（21 个文件），不含安装包与清单 |
| ECS `/var/www/xiaotu` | `xiaotu.online` | 同一份网页（备案中，80 端口暂被拦截） |

两个桶的根目录都配置了静态托管，`dl.xiaotu.online/` 的 `index.html` 是一个跳转到 `pre.xiaotu.online` 的过渡页，`404.html` 为自定义错误页。

## 二、目录规则

```
/                          404.html、index.html（跳转到 pre.xiaotu.online）
/logs/                     每小时访问日志
/<product>/                dmg / exe / zip、manual.pdf、release-notes-*.html
/<product>/updates/stable/  appcast.xml、latest.json、windows.json
```

`<product>` 取值为 `devcard`、`xiaotu`、`mote`。

## 三、自动更新清单（三个产品路径完全一致）

| 产品 | appcast.xml（Sparkle） | latest.json（macOS） | windows.json（Windows） |
|---|---|---|---|
| DevCard | `devcard/updates/stable/appcast.xml` | `devcard/updates/stable/latest.json` | `devcard/updates/stable/windows.json` |
| 小兔进销存 | `xiaotu/updates/stable/appcast.xml` | `xiaotu/updates/stable/latest.json` | `xiaotu/updates/stable/windows.json` |
| Mote | `mote/updates/stable/appcast.xml` | `mote/updates/stable/latest.json` | `mote/updates/stable/windows.json` |

完整地址示例：

```
https://dl.xiaotu.online/xiaotu/updates/stable/windows.json
```

## 四、安装包

### DevCard（macOS 当前 1.2.3，Windows 当前 1.2.2）

| 类型 | 文件 | 大小（字节） |
|---|---|---|
| DMG | `devcard/DevCard-1.2.3-macos-arm64.dmg` | 5,977,010 |
| DMG | `devcard/DevCard-1.2.2-macos-arm64.dmg` | 5,969,510 |
| DMG | `devcard/DevCard-1.2.1-macos-arm64.dmg` | 5,924,494 |
| DMG | `devcard/DevCard-1.2.0-macos-arm64.dmg` | 4,790,698 |
| 验签 | 每个 dmg 旁的 `DevCard-<版本>-macos-arm64.dmg.edSignature`（89 B） | — |
| EXE | `devcard/DevCard-1.2.2-setup.exe` | 5,781,239 |
| EXE | `devcard/DevCard-1.2.1-setup.exe` | 5,818,875 |
| EXE | `devcard/DevCard-1.2.0-setup.exe` | 5,654,984 |
| ZIP | `devcard/DevCard-1.2.2-win64-portable.zip` | 5,984,916 |
| ZIP | `devcard/DevCard-1.2.1-win64-portable.zip` | 6,033,802 |
| ZIP | `devcard/DevCard-1.2.0-win64-portable.zip` | 5,750,450 |

### 小兔进销存（macOS / Windows 当前均为 1.0.0）

| 类型 | 文件 | 大小（字节） |
|---|---|---|
| DMG | `xiaotu/xiaotu-inventory-1.0.0.dmg` | 6,378,546 |
| DMG | `xiaotu/xiaotu-inventory-0.9.0.dmg` | 6,633,958 |
| EXE | `xiaotu/xiaotu-inventory-1.0.0-win64-setup.exe` | 3,690,759 |
| EXE | `xiaotu/xiaotu-inventory-0.9.0-win64-setup.exe` | 3,580,457 |
| ZIP | `xiaotu/xiaotu-inventory-1.0.0-win64.zip` | 2,433,248 |
| ZIP | `xiaotu/xiaotu-inventory-0.9.0-win64.zip` | 2,137,094 |

### Mote（当前 1.0.1）

| 类型 | 文件 | 大小（字节） |
|---|---|---|
| DMG | `mote/Mote-macOS-native-1.0.1.dmg` | 1,794,986 |
| DMG | `mote/Mote-macOS-native-1.0.0.dmg` | 1,794,731 |
| DMG | 0.3.4 ~ 0.3.11 共 7 个历史版本 | 580,303 ~ 1,794,810 |
| EXE | `mote/Mote-Setup-1.0.1.exe` | 2,650,735 |
| EXE | `mote/Mote-Setup-1.0.0.exe` | 2,645,781 |
| EXE | 0.3.7 ~ 0.3.11 共 5 个历史版本 | 2,561,252 ~ 2,646,030 |
| ZIP | `mote/Mote-1.0.1-win64-portable.zip` | 677,418 |
| ZIP | `mote/Mote-1.0.0-win64-portable.zip` | 670,738 |
| ZIP | 0.3.7 ~ 0.3.11 共 5 个历史版本 | 628,975 ~ 670,714 |

## 五、PDF 与发布说明

| 文件 | 大小（字节） | 缓存 |
|---|---|---|
| `devcard/manual.pdf` | 5,563,312 | 1 天 |
| `xiaotu/manual.pdf` | 3,702,580 | 1 天 |
| `mote/manual.pdf` | 8,140,873 | 1 天 |
| `mote/release-notes-1.0.1.html` | 7,457 | 1 小时 |
| `mote/release-notes-1.0.0.html` | 9,271 | 1 小时 |

## 六、缓存策略

| 类型 | Cache-Control |
|---|---|
| dmg / exe / zip | `public, max-age=31536000, immutable` |
| appcast.xml / latest.json / windows.json | `no-cache, max-age=60` |
| manual.pdf | `public, max-age=86400` |
| release-notes-*.html | `public, max-age=3600` |
| *.dmg.edSignature | `public, max-age=300` |

## 七、谁读哪个文件

| 消费方 | 读取 |
|---|---|
| DevCard macOS 自动更新 | `latest.json` 的 `assets[]`（`.dmg`） |
| DevCard Windows 自动更新 | `windows.json` 的 `assets[]`（`.exe` 优先于 `.zip`） |
| DevCard Sparkle（安装流程） | `appcast.xml` + `.edSignature` |
| 小兔 macOS 更新 / Sparkle | `latest.json` / `appcast.xml` |
| 小兔 Windows 更新 | `windows.json`（`size/sha256` 与 `portable_*`） |
| Mote macOS 更新 / Sparkle | `latest.json` / `appcast.xml` |
| Mote Windows 更新 | `windows.json` |
| 官网下载页 | 上述清单，自动刷新版本号、大小、SHA256、下载链接 |

## 八、发布命令

```bash
# 产品包与更新清单（在各自仓库）
xiaotu-inventory/tools/package/publish_oss.sh        # macOS
xiaotu-inventory/tools/package/publish_windows.sh    # Windows
dev_card_cpp/tools/release/upload_oss.py             # DevCard
mote/tools/release/publish_macos.sh                  # Mote macOS
mote/tools/release/publish_windows.sh                # Mote Windows

# 官网（mote 仓库）
bash tools/release/publish_site_oss.sh   # OSS → pre.xiaotu.online
bash tools/release/deploy_site.sh        # ECS → xiaotu.online
```

## 九、备注

1. DevCard 1.2.3 只发布了 macOS，Windows 清单仍是 1.2.2。
2. `xiaotu/xiaotu-inventory-1.0.0-win64.zip` 的 Content-Type 已于 2026-11-18 修正为 `application/zip`；其余 zip 均为 `application/zip`，历史上传若发现 `application/octet-stream` 可按同样方式修正。
3. 更新清单缓存 60 秒，发布后最多 1 分钟生效；安装包因 `immutable` 长期缓存，覆盖同名文件不会生效，必须换版本号。
