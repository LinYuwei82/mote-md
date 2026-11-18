# 更新清单 Schema v2（统一设计稿）

> 状态：**迁移完成**（2026-11-18 全量上线并退役 v1）。
> 全链路完成：生成器 `manifest_v2.py`、guard v2 检查、三仓库发布脚本、
> 三个客户端解析 + Ed25519 验签、下载页改读 manifest.json；
> 新内测版已发布：mote 1.0.3 / xiaotu 1.0.2 / devcard 1.2.7，
> 升级链路实测全绿后，v1 清单（`latest.json` / `windows.json`）已全部删除
> （`appcast.xml` 永久保留）。
> 2026-11-19：桶内历史安装包（v1 命名 + v2 旧版本，共 116 MB）已全部清理，
> 每个产品只保留当前版本 3 个包。
> 2026-11-19：修复 Windows 清单 `build` 错位——发布脚本原先取「发布时刻」，
> 二进制里却是「编译时刻」，清单永远比安装包新，客户端反复提示同一版本。
> 现由构建步骤把 `MOTE_BUILD` 传给发布步骤，`build` 必须等于二进制内的值（见 3.4）；
> mote 1.0.4 按此规则重发。
> 2026-11-19：DevCard 1.2.8 待发布——WebView 内没有 Ed25519，远端清单改由本地服务端
> `POST /api/version/verify` 验签后再提供 `artifacts`（见第四节），修复「下载更新包 /
> 安装并重启」在没有本地清单时永远置灰的问题。
> 日期：2026-11-18
> 适用仓库：`xiaotu-inventory`、`dev_card_cpp`、`mote`
> 背景：三款产品均在内测期、无存量用户，趁此窗口把清单格式一次统一，
> 不做长期双写过渡（旧内测版重装或自动升一次即可）。

## 一、目标

1. 一个产品一个清单文件 `manifest.json`，同时覆盖 macOS 与 Windows，
   替代现在的 `latest.json` + `windows.json` 两份。
2. 三个产品共用同一 schema、同一签名方案、同一安装包命名规则。
3. `appcast.xml`（Sparkle 协议）**不在统一范围内**，路径与格式均不变。

## 二、文件与路径

| 对象键 | 缓存 | 说明 |
|---|---|---|
| `<product>/updates/<channel>/manifest.json` | `no-cache, max-age=60` | 唯一 JSON 清单 |
| `<product>/updates/<channel>/appcast.xml` | `no-cache, max-age=60` | Sparkle 专用，格式不变 |

`<product>` ∈ `devcard` / `xiaotu` / `mote`；`<channel>` ∈ `stable` / `beta`。

## 三、Schema 定义

### 3.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `manifest_version` | int | 是 | 固定 `2` |
| `product` | string | 是 | `devcard` / `xiaotu` / `mote` |
| `channel` | string | 是 | `stable` / `beta` |
| `key_id` | string | 是 | 签名密钥代号，如 `2026-11`；轮换密钥时换新代号 |
| `updated_at` | string | 是 | ISO 8601 UTC，如 `2026-11-18T04:48:54Z` |
| `platforms` | object | 是 | 至少含 `macos` 或 `windows` 之一 |
| `signature` | string | 是 | Ed25519 签名，base64，见第四节 |

### 3.2 platform 层（`platforms.macos` / `platforms.windows`）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | string | 是 | semver，如 `1.0.2`；平台间版本独立递增 |
| `build` | int | 是 | Windows 构建号，必须等于二进制内编译时的 `MOTE_BUILD`（如 `202611181542`），见 3.4；macOS 无构建号填 `0` |
| `min_os` | string | 是 | 如 `14.0` / `10.0` |
| `notes_url` | string | 否 | 发布说明页，绝对 https 地址；客户端「查看更新详情」直接打开；缺省不发 |
| `rollout_percent` | int | 否 | 0–100，缺省 `100`（灰度用） |
| `mandatory` | bool | 是 | 强制更新开关（现仅小兔使用） |
| `mandatory_deadline` | string | 否 | ISO 8601 UTC |
| `mandatory_reason` | string | 否 | |
| `artifacts` | object | 是 | 见 3.3 |

> `notes_url` 一律由发布脚本写入：仓库存在 `docs/release-notes-<版本>.html` 时，随发布上传到
> `<product>/release-notes-<版本>.html` 并填入该字段；缺页则不写，避免客户端出现死链。
> 小兔 1.0.3 起，Windows 更新卡片在 `notes_url` 非空时显示「查看更新详情」，
> 调用系统默认浏览器打开；该字段为空则按钮不出现。

### 3.3 artifacts

key 枚举：`dmg`（macOS 安装包）/ `setup`（Windows 安装版）/ `portable`（Windows 绿色包）。
每个产物结构统一：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 绝对 https，immutable 长缓存对象 |
| `size` | int | 是 | 字节数 |
| `sha256` | string | 是 | 小写十六进制 |

必填规则：`macos.artifacts` 至少含 `dmg`；`windows.artifacts` 至少含 `setup` 或 `portable`。
客户端遇到未知的 artifacts key / 未知字段一律忽略，保证未来可扩展。

### 3.4 构建号一致性（Windows 必读）

`build` 不是「发布时刻」的流水号，而是**编译进二进制**的 `MOTE_BUILD`：

| 环节 | 取值 |
|---|---|
| 构建（configure） | `-DMOTE_BUILD=<UTC yyyyMMddHHmm>`：写进 CMakeCache，同时编进 `Mote.exe` |
| 打包 / 发布 | 从 CMakeCache 读同一个值（Actions 由构建步骤经 `MOTE_BUILD_STAMP` 传递），写进 `manifest.json` |

两者不一致的后果：

- 清单 `build` **大于**安装包内的值：客户端同版本时判定「有新版本」，装完本机值没变，
  下次检测继续提示——表现为「已经是 1.0.4，却一直提示更新 1.0.4」；
- 清单 `build` **小于**安装包内的值：该构建永远收不到更新提示。

约束：`publish_windows.ps1` 未显式传 `-Build` 时从 `build-native-ninja/CMakeCache.txt`
读取编译值，读不到直接失败，不再退回当前时间；`release-windows.yml` 会把构建步骤
实际生效的值传给发布步骤。发布后按[发布工作流](./发布工作流.md) 第 6 节核对。

## 四、签名规则

与现小兔 `update_manifest.py` 完全同一算法（实现可直接复用）：

1. 取整个 JSON 对象，**去掉 `signature` 字段**；
2. 按键名排序（递归）、紧凑输出（无空白分隔符）、UTF-8 编码，得到 canonical bytes；
3. Ed25519 私钥对 canonical bytes 签名，base64 标准编码写入 `signature`；
4. 验签方按同样规则重算 canonical bytes 后 `verify`。

- 三家各自一把 Ed25519 私钥，私钥路径不变（见[发布工作流](./发布工作流.md) 2.1 节）。
- `key_id` 随公钥一同编译进客户端；轮换密钥 = 新 `key_id` + 新公钥随下一个客户端版本发布。
- 客户端验签现状：**三家均已接入**。小兔 macOS 用 OpenSSL Ed25519 实现
  （`xiaotu::verify_manifest_signature`），公钥取 `Info.plist` 的 `SUPublicEDKey`
  （打包时注入，与 Sparkle 的 appcast 共用同一把）；小兔 Windows 桥与 Mote 用内嵌
  Ed25519 实现，公钥随客户端编译。DevCard 的验签放在**本地服务端**：数据目录有
  `manifest.json` 时由 `/api/version` 直接返回验签结果；没有本地清单时，页面把远端清单
  原文交回 `POST /api/version/verify`，服务端用内嵌公钥验签后才返回 `artifacts`
  （WebView 自身无法验签，不能让它直接采信远端资产）。验签失败一律放弃本次更新。

## 五、完整示例（mote，数据取自线上 v1 改编）

```json
{
  "manifest_version": 2,
  "product": "mote",
  "channel": "stable",
  "key_id": "2026-11",
  "updated_at": "2026-11-18T04:48:54Z",
  "platforms": {
    "macos": {
      "version": "1.0.1",
      "build": 0,
      "min_os": "14.0",
      "artifacts": {
        "dmg": {
          "url": "https://dl.xiaotu.online/mote/mote-1.0.1-macos-arm64.dmg",
          "size": 1794986,
          "sha256": "6f6f9fbd61145aca92be509d6595ce376d88746790b714ca1a22d9a9b889e11a"
        }
      }
    },
    "windows": {
      "version": "1.0.2",
      "build": 202611180530,
      "min_os": "10.0",
      "notes_url": "https://dl.xiaotu.online/mote/release-notes-1.0.2.html",
      "artifacts": {
        "portable": {
          "url": "https://dl.xiaotu.online/mote/mote-1.0.2-win64-portable.zip",
          "size": 702247,
          "sha256": "8fdcb41338deb9385308537a9ec4434a11b13bf250bf81f43c0817c804cf0dcc"
        },
        "setup": {
          "url": "https://dl.xiaotu.online/mote/mote-1.0.2-win64-setup.exe",
          "size": 2655925,
          "sha256": "9b9c18c6a21f5d4b44bb804aa6a8f683f95035f6018cb35ee27918fe48b2ac16"
        }
      }
    }
  },
  "signature": "（生成时计算）"
}
```

## 六、客户端解析规则

1. 只取 `platforms.<自己的平台>`，忽略另一平台与一切未知字段。
2. 更新判定：macOS 只比 `version`；Windows 先比 `version`，同版本再比 `build`
   （`build` 小于等于本机 → 无更新，沿用小兔现状）。所以清单里的 `build` 必须与
   安装包内编译时的 `MOTE_BUILD` 逐位相同，否则同版本会反复提示，见 3.4。
3. 产物选择：Windows 安装版读 `artifacts.setup`，绿色包读 `artifacts.portable`；
   macOS 读 `artifacts.dmg`。
4. 校验顺序：
   - 两端都在拿到清单后**先验 `signature`**，失败直接放弃（不比较版本、不下载）。
   - Windows：下载完成后校验 `artifacts.*.sha256` 与 size，两者都过才安装。
   - macOS：manifest 的 `sha256` 只用于自研预下载；最终安装由 Sparkle 按
     `appcast.xml` **重新下载**并验证其中的 EdDSA 签名，不以 manifest 的 sha256
     作为安装前校验。
5. `rollout_percent` / `mandatory` 按各客户端现有逻辑消费，schema 层面三家一致。

## 七、安装包命名统一（随 v2 一并执行）

规则：小写、连字符分隔，`<product>-<version>-<os>-<arch>-<type>.<ext>`。

| 旧名（现状） | 新名（v2） |
|---|---|
| `DevCard-1.2.5-setup.exe` | `devcard-1.2.5-win64-setup.exe` |
| `DevCard-1.2.5-win64-portable.zip` | `devcard-1.2.5-win64-portable.zip` |
| `DevCard-1.2.4-macos-arm64.dmg` | `devcard-1.2.4-macos-arm64.dmg` |
| `Mote-Setup-1.0.2.exe` | `mote-1.0.2-win64-setup.exe` |
| `Mote-1.0.2-win64-portable.zip` | `mote-1.0.2-win64-portable.zip` |
| `Mote-macOS-native-1.0.1.dmg` | `mote-1.0.1-macos-arm64.dmg` |
| `xiaotu-inventory-1.0.1-win64-setup.exe` | `xiaotu-1.0.1-win64-setup.exe` |

安装包 immutable，旧文件无需重命名，新版本起自然使用新名。
guard 按此规则校验命名，清理脚本按 `<product>-<version>` 前缀分组。

## 八、清单生成器：三仓库同步一份

仿照 `guard.py` 的同步模式：统一生成/签名脚本 `tools/release/manifest_v2.py`
以 mote 为主本，三仓库同文件 + `manifest_v2.sha256` 哈希校验，
由 `sync_guard.sh` 一并同步（guard 与 manifest_v2 同一脚本维护）。
三个发布脚本调用它生成并签名 manifest.json，不再各自 printf 拼 JSON
（Mote 的 windows.json 目前就是手工拼接且**未签名**，v2 一并补上）。

## 九、改动清单

| 位置 | 改动 |
|---|---|
| `mote/tools/release/manifest_v2.py`（新） | 统一生成 + 签名 + 本地验签，三仓库同步 |
| 三家发布脚本（`publish_macos.sh` / `publish_oss.sh` / `publish_windows.*`） | 改调 manifest_v2.py，上传 `manifest.json` |
| `guard.py` | preflight/verify-live 增加 v2 检查（schema、签名、命名、URL 一致性） |
| 下载页 `site.js` | 改读 `manifest.json`，取 `platforms.*.version` |
| 小兔客户端 | 解析 v2（读 `platforms.windows`）+ 内嵌 URL 换 manifest.json |
| DevCard 客户端 | 同上 + 接入 Ed25519 验签 |
| Mote 客户端 | 同上 + 接入 Ed25519 验签 |
| 文档 | 本文件状态更新；`OSS-发布布局.md`、`发布工作流.md` 对齐 |

## 十、切换步骤

1. 本文档评审定稿。
2. 实现 `manifest_v2.py` + guard v2 检查，三仓库同步。
3. 三家发布脚本切换，本地 dry-run 产出 manifest.json 并验签。
4. 客户端改造（解析 v2 + 验签 + 新 URL），各发一个内测版。
5. 上线顺序：**先传 manifest.json → 发新客户端 → 旧内测版升上来后**
   删除 `latest.json` / `windows.json`（v1 文件在旧客户端退役前不可删）。
6. 更新 `OSS-发布布局.md` 与 `发布工作流.md`。

## 十一、决策记录

### 已确认（2026-11-18）

| 决策 | 结论 |
|---|---|
| 清单文件名 | **`manifest.json`**（新名字明确区分 v1/v2，客户端切换期互不干扰） |
| 安装包统一命名 | **随 v2 执行**，`<product>-<version>-<os>-<arch>-<type>.<ext>`；macOS dmg 带 `-arm64` 后缀 |
| dmg 卷名 | 小兔 dmg 卷名改英文 `Xiaotu Inventory`（中文卷名在自动化/沙箱环境 hdiutil 会被 TCC 拦截；自 1.0.2 起生效） |
| Mote 清单密钥 | 独立轮换（2026-11-18），与 Sparkle 密钥、小兔密钥解耦；客户端公钥随 1.0.3 发布 |

### 待确认

无——全部决策点已确认。

### 决策明细

| 决策 | 结论 |
|---|---|
| `check_endpoint` / `check_interval_hours` | **去掉**（URL 内嵌于客户端，检查间隔为客户端配置） |
| 生成器同步机制 | **并入 `sync_guard.sh`**，与其同步 `manifest_v2.py` 及其哈希文件 |
