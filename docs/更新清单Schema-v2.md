# 更新清单 Schema v2（统一设计稿）

> 状态：**迁移完成**（2026-11-18 全量上线并退役 v1）。
> 全链路完成：生成器 `manifest_v2.py`、guard v2 检查、三仓库发布脚本、
> 三个客户端解析 + Ed25519 验签、下载页改读 manifest.json；
> 新内测版已发布：当前线上为 mote 1.0.6（Windows build 为旧编号 `202611191435`）、
> xiaotu 1.0.3（build `202611190001`）、devcard 1.2.8（build `202611181646`）。
> **构建号口径（当前）**：正式发布的 tag 为 `v<semver>+<seq>`，`build = seq`
> （从 1 起、无固定基数）；下面的日期构建号只出现在历史发布记录里。
> 升级链路实测全绿后，v1 清单（`latest.json` / `windows.json`）已全部删除
> （`appcast.xml` 永久保留）。`guard.py --schema v1` 参数已于 2026-11-19 移除，
> 强制 v2。
> 2026-11-19：按清单/appcast 白名单清理过一次历史安装包（116 MB）；同日再清
> mote 1.0.3 / 1.0.4 全套（8 个对象，10 MB）。mote 1.0.4 macOS DMG 是缺
> Sparkle.framework 的残缺包（750 KB），清理后彻底消除误伤可能。
> devcard 1.2.6 / 1.2.7、xiaotu 1.0.2 的包仍保留在桶内供回滚。
> 2026-11-19：修复 Windows 清单 `build` 错位——发布脚本原先取「发布时刻」，
> 二进制里却是「编译时刻」，清单永远比安装包新，客户端反复提示同一版本。
> 现由构建步骤把 `MOTE_BUILD` 传给发布步骤，`build` 必须等于二进制内的值（见 3.4）；
> mote 1.0.4 按此规则重发。
> 2026-11-19：小兔 1.0.3（macOS build `202611181448`）起，macOS 的「是否有更新 / 待安装 /
> 验证期 / 恢复模式」全部按 `version` 判定。此前 `platforms.macos.build` 恒为 `0`，却被拿去
> 和本地日期构建号比较，导致 macOS 更新入口实际不可用；当时把 macOS 段的 `build` 仅作占位。
> **2026-11-20 起 Mote macOS 也注入真实 `MOTE_BUILD`，同版本重发可按 build 区分；
> 当前两端判定口径一致（先比 version，同版本再比 build）。**
> 2026-11-19：小兔 1.0.3 的发行说明页已补传（`xiaotu/release-notes-1.0.3.html`，3,886 字节），
> 清单已重签并在 `platforms.macos` / `platforms.windows` 写入 `notes_url`。
> 2026-11-19：DevCard 1.2.8 已发布——WebView 内没有 Ed25519，远端清单改由本地服务端
> `POST /api/version/verify` 验签后再提供 `artifacts`（见第四节），修复「下载更新包 /
> 安装并重启」在没有本地清单时永远置灰的问题。
> 2026-11-19：DevCard 补齐 Windows 构建号注入机制（`DEVCARD_BUILD` CMake 选项 →
> `compiled_build_number()` 条件编译返回注入值），与小兔 / Mote 对齐；未注入时回退 0
> 自动跳过同版本 build 比较（向后兼容所有存量客户端与存量清单）。
> DevCard 当前阶段 macOS + Windows 同步发布，v2 manifest.json 必须同时含
> `platforms.macos` + `platforms.windows`（`guard.py preflight` 强制，缺失任一 die 拦截）。
> 2026-11-19：`manifest_v2.py resign` 扩展为可改 `notes_url`（`--notes-url`），
> 补发说明页无需重新打包；三份线上清单（devcard 1.2.8、xiaotu 1.0.3、mote 1.0.4）
> 现均含该字段。工具改动已通过 `sync_guard.sh` 同步到另外两个仓库。
> 2026-11-20：DevCard BUILD_STR 双宏落地（`DEVCARD_BUILD=<int>` + `DEVCARD_BUILD_STR="<int>"`），guard.py 对三产品做相同的 BUILD_STR 二次校验不再跳过 DevCard，selftest 补 DevCard 正向用例；sync_guard.sh `--check-build-str` 覆盖 DevCard；DevCard Windows 发版前验证工具 `verify_build_stamp.ps1`（零依赖 PowerShell 5，7 PASS + T7 SKIP，见[发布工作流 §4.1](./发布工作流.md#devcard-windows-构建号注入验证步骤每次发版前必跑)）；三仓库新增 UTF-8 BOM 三道闸（`.gitattributes` + `tools/hooks/pre-commit` + `setup-hooks.ps1`）。
> 日期：2026-11-20
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
| `build` | int | 是 | 两端都由编译期宏注入：小兔 `XIAOTU_BUILD`、Mote `MOTE_BUILD`、DevCard `DEVCARD_BUILD`，必须等于二进制内编译时的值，见 3.4。正式发布取 tag `v<semver>+<seq>` 的序号（从 1 起，无固定基数）；客户端同版本时再比 build |
| `min_os` | string | 是 | 如 `14.0` / `10.0` |
| `notes_url` | string | 否 | 发布说明页，绝对 https 地址；客户端「查看更新详情」直接打开；缺省不发 |
| `rollout_percent` | int | 否 | 0–100，缺省 `100`（灰度用） |
| `mandatory` | bool | 否 | 强制更新开关；缺省为 `false`。为 `true` 时跳过灰度与「稍后」，客户端只给「立即更新」，见 6.2。发布脚本只在传 `--mandatory` 时写入，当前三份线上清单均无此字段 |
| `mandatory_deadline` | string | 否 | ISO 8601 UTC，仅用于提示升级期限，客户端不据此放行，见 6.2 |
| `mandatory_reason` | string | 否 | `SECURITY` / `PROTOCOL` / `REGULATORY` / `MIN_SUPPORTED` 四类之一；`mandatory` 为 `false` 时客户端解析会清空该字段 |
| `artifacts` | object | 是 | 见 3.3 |

> `notes_url` 由发布脚本写入：三家脚本都检测仓库里的
> `docs/release-notes-<版本>.html`，存在时连同产物一起上传到
> `<product>/release-notes-<版本>.html` 并填入该字段；缺页则不写，避免客户端出现死链。
> Mote 的 macOS 脚本自 2026-11-19 起也走同一规则（此前只接受显式的 `NOTES_URL`）。
> 当前三份线上清单均含该字段：devcard 1.2.8、xiaotu 1.0.3、mote 1.0.4。其中后两份是
> 发布后补传说明页、再改 `notes_url` 整体重签并自验签完成的，详见 `OSS-发布布局.md` 第四节。
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

### 3.4 构建号一致性（两端必读）

`build` 不是「发布时刻」的流水号，而是**发布 tag 的序号**，并且必须原样编译进二进制。三产品注入机制统一，但宏名略有差异：

| 产品 | 整数宏（CMake configure 直接注入，写进 CMakeCache） | 字符串宏（壳源码拼接 BUILD_STR 用） | 壳源码 BUILD_STR 位置 |
|---|---|---|---|
| Mote | `-DMOTE_BUILD=<seq>` | `-DMOTE_BUILD_STR="<seq>"`（`native/CMakeLists.txt` 一处注入） | `shell/win/updater_win.cpp`：`constexpr kBuildStamp[] = "MOTE_BUILD=" MOTE_BUILD_STR` |
| 小兔 | `-DXIAOTU_BUILD=<seq>` | `-DXIAOTU_BUILD_STR="<seq>"`（顶层只校验，实际注入分散在 `shell/win/CMakeLists.txt` 给 updater、`core/CMakeLists.txt` 给 core） | `shell/win/updater_win.cpp`：`constexpr kBuildStamp[] = "XIAOTU_BUILD=" XIAOTU_BUILD_STR` |
| DevCard | `-DDEVCARD_BUILD=<seq>`（函数注入） | `-DDEVCARD_BUILD_STR="<seq>"`（`cmake/devcard_version.cmake` 的 `devcard_add_build_stamp(target)` 函数同时注入双宏） | `shell/win/main.cpp`：`constexpr kBuildStamp[] = "DEVCARD_BUILD=" DEVCARD_BUILD_STR` |

DevCard 双宏原因：core 模块里的 `compiled_build_number()` 需要纯整数宏做 `static_cast<uint64_t>`；shell 里的 BUILD_STR 需要字符串宏做 C++ 字符串字面量拼接。**分开注入、各司其职，缺一不可**。guard.py 统一搜索的前缀是 `b"DEVCARD_BUILD="`。

三者不一致的后果：

- 清单 `build` **大于**安装包内的值：客户端同版本时判定「有新版本」，装完本机值没变，
  下次检测继续提示——表现为「已经是 1.0.4，却一直提示更新 1.0.4」；
- 清单 `build` **小于**安装包内的值：该构建永远收不到更新提示。

#### BUILD_STR 二次校验（guard.py preflight 自动执行）

2026-11-19 起 guard.py 在 preflight 里新增**二进制内 build 号二次校验**：

```
绿色包 zip  ──→ _read_exe_bytes  ──→ 搜 b"MOTE_BUILD=(\d+)"  ──→ 与 --build 参数比对
setup.exe  ──→ innounp 解包壳  ──→ 同上
```

| 场景 | guard.py 行为 |
|---|---|
| zip + setup 同时存在 | 只扫 zip（壳是同一份编译产物，等价）；setup 那条跳过 `✓ setup.exe 同源于已校验的绿色包` |
| 只有 zip | 解包 zip → 扫壳 EXE（Mote `Mote.exe` / 小兔 `xiaotu-shell.exe` / DevCard `DevCard.exe`） → 比对 |
| 只有 setup | innounp 解包 ISCC 安装包 → 扫内部壳 EXE → 比对 |
| 三产品统一前缀 | `_BUILD_STAMP_PREFIX = {"mote": b"MOTE_BUILD=", "xiaotu": b"XIAOTU_BUILD=", "devcard": b"DEVCARD_BUILD="}`，不再跳过 DevCard |

比对不一致 → **阻断发布**（ExitCode 1，`die()`），再也不会出现"清单 build 大于安装包内值"的事故。

#### innounp：解包 ISCC setup.exe

setup.exe 是 Inno Setup 6 压缩包，直接读字节找不到内部壳 EXE。guard.py 用 **innounp** 解包：

| 项 | 说明 |
|---|---|
| 原版 innounp 0.50 | innounp.sourceforge.net，支持 ISCC ≤ 6.1 |
| innounp-2 fork 2.70.1 | github.com/jrathlev/InnoUnpacker-Windows-GUI，支持 ISCC **6.7+** |
| guard.py 查找顺序 | PATH → `~/.local-bin` → guard.py 同目录 → ISCC 安装目录 |
| CI 部署 | 小兔 / Mote `release-windows.yml` 打安装包后自动下载 innounp-2 到 `~/.local-bin` |

约束：`publish_windows.ps1` 未显式传 `-Build` 时从 `CMakeCache.txt` 读取编译值，
读不到直接失败，不再退回当前时间；`release-windows.yml` 会把构建步骤
实际生效的值传给发布步骤。发布后按[发布工作流](./发布工作流.md) 第 6 节核对。

**DevCard 与小兔 / Mote 全链路对齐（2026-11-20 最终完成）**：此前 DevCard Windows 客户端没有可靠的本机构建号（版本资源第 4 段恒 `0`），同版本不比 `build`、修复只能升 `version`。现通过 `cmake/devcard_version.cmake` 的 `devcard_add_build_stamp(target)` 函数，同时注入两个独立宏：
- `DEVCARD_BUILD=<seq>`（整数宏，`core` 里 `static_cast<uint64_t>` 用）
- `DEVCARD_BUILD_STR="<seq>"`（字符串宏，`shell/win/main.cpp` 里拼接 `"DEVCARD_BUILD=" DEVCARD_BUILD_STR` 进 BUILD_STR 静态字符串）

guard.py 2026-11-20 起对三产品做相同的 BUILD_STR 二次校验，`_BUILD_STAMP_PREFIX["devcard"] = b"DEVCARD_BUILD="`，selftest 也补了 DevCard 正向用例（绿色包 `DevCard.exe` 含 `DEVCARD_BUILD=<digits>`）。未注入时 `compiled_build_number()` 返回 0，自动跳过 build 比较，向后兼容。

DevCard Windows 发版前验证工具：`dev_card_cpp/tools/release/verify_build_stamp.ps1`（零依赖纯 PowerShell 5，一次性跑通 **cmake 双宏注入 → CMakeCache 落盘 → devcard_core_tests 运行时断言 → DevCard.exe BUILD_STR 字节 grep → 无注入回退链路 → manifest 生成对齐** 6 项验证 + 1 项可选签名验证）。完整运行命令、覆盖项表、实测输出示例见 [发布工作流 §4.1 验证步骤](./发布工作流.md#devcard-windows-构建号注入验证步骤每次发版前必跑)。

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

## 五、完整示例（mote 1.0.6，取自线上实际清单，`signature` 省略）

```json
{
  "manifest_version": 2,
  "product": "mote",
  "channel": "stable",
  "key_id": "2026-11",
  "updated_at": "2026-11-20T00:50:41Z",
  "platforms": {
    "macos": {
      "version": "1.0.6",
      "build": 0,
      "min_os": "14.0",
      "rollout_percent": 100,
      "artifacts": {
        "dmg": {
          "url": "https://dl.xiaotu.online/mote/mote-1.0.6-macos-arm64.dmg",
          "size": 1829951,
          "sha256": "5b0e132b6c42df7bf82cc8ea777efccb472a301cd1b8c052874413fea6eb533e"
        }
      }
    },
    "windows": {
      "version": "1.0.6",
      "build": 202611191435,
      "min_os": "10.0",
      "rollout_percent": 100,
      "artifacts": {
        "portable": {
          "url": "https://dl.xiaotu.online/mote/mote-1.0.6-win64-portable.zip",
          "size": 693311,
          "sha256": "3dcb3c1416eeb526480590749bfd640a330735d43040d2a8bc7ccf154d7ca84f"
        },
        "setup": {
          "url": "https://dl.xiaotu.online/mote/mote-1.0.6-win64-setup.exe",
          "size": 2662393,
          "sha256": "e4267f169244147084c504e4809b6c117d43b66e9633281563974116a5ee6395"
        }
      }
    }
  },
  "signature": "dmV+aBBh7qutNLgMmb5Gj7lR9lBMyZit7Ev4C7aUag8RDLM7VAqaVKhdgWp160Ly9Ese40UQpN/2jS0pRCnkBA=="
}
```

> 示例取自线上 1.0.6 清单（签名保留完整值；该版生成于旧口径，macOS `build` 仍为 0，
> 新发布的清单一律两端写真实 `MOTE_BUILD`）。与 1.0.4 残缺 DMG（750 KB、缺
> Sparkle.framework）不同，1.0.6 DMG 含完整 Sparkle.framework（`.app` 约 4.2 MB），
> macOS 端自动更新恢复正常。生成该清单时 `docs/release-notes-1.0.6.html` 尚未上传，
> 故 `notes_url` 为空；该页现已补齐，后续发布脚本会自动带上。

## 六、客户端解析规则

1. 只取 `platforms.<自己的平台>`，忽略另一平台与一切未知字段。
2. 更新判定：
   - macOS 与 Windows 口径一致：先比 `version`，同版本再比 `build`；本机 build 未知（≤0）时跳过 build 比较。
   - 正式发布的 `build` 取 tag `v<semver>+<seq>` 的序号；清单 `build` 必须与安装包内编译值逐位相同，否则同版本会反复提示，见 3.4。
   - 同版本重发靠递增序号让客户端感知；需要改变产品版本时仍要递增 `version`。
3. 产物选择：Windows 安装版读 `artifacts.setup`，绿色包读 `artifacts.portable`；
   macOS 读 `artifacts.dmg`。
4. 校验顺序：
   - 两端都在拿到清单后**先验 `signature`**，失败直接放弃（不比较版本、不下载）。
   - Windows：下载完成后校验 `artifacts.*.sha256` 与 size，两者都过才安装。
   - macOS：manifest 的 `sha256` 只用于自研预下载；最终安装由 Sparkle 按
     `appcast.xml` **重新下载**并验证其中的 EdDSA 签名，不以 manifest 的 sha256
     作为安装前校验。
5. `rollout_percent` / `mandatory` 的消费口径见 6.1（灰度分桶）与 6.2（强制更新），
   schema 层面三家一致。

### 6.1 灰度分桶算法（唯一口径）

三产品共用同一算法，输入只有客户端 `install_id` 与清单 `platforms.<平台>.build`：

1. `material = install_id + ":" + 十进制 build`（无空格，UTF-8 字节）；
2. `digest = SHA-256(material)`；
3. `bucket = big_endian_uint32(digest[0..3]) % 100`，取值固定 `0–99`；
4. 命中条件：`mandatory == true`，或 `bucket < clamp(rollout_percent, 0, 100)`。
   未命中即不下发本次更新（客户端提示「暂无可用更新」/ 后台静默等待下一轮）。

`install_id` 由客户端首次检查更新时生成并持久化，此后不变：Windows 存
`HKCU\Software\Mote\InstallId`（16 字节系统 CSPRNG，32 位十六进制），macOS 存
`NSUserDefaults` 的 `MoteInstallId`（UUID 字符串）。因此同一台机器对同一 `build`
的桶位固定，放量只需递增 `rollout_percent`，不会出现「抽中又被收回」。

参考实现：小兔 `core/src/update.cpp` 的 `rollout_bucket` / `rollout_allows`，
DevCard `core/src/update_manifest.cpp` 的同名函数，Mote
`modules/update/src/update.cpp` 的 `rolloutBucket` / `rolloutAllows`。
三处必须逐位一致：改动算法需同一次提交同步三仓库，并更新本节。

### 6.2 强制更新语义（唯一口径）

`mandatory == true` 时三端行为一致（2026-11-20 起 Mote 补齐，同日补齐期限宽限）：

1. **判定**：跳过灰度分桶与「稍后/已跳过该版本」记录，只要版本更新就下发
   （这条与期限无关——确保强制版本能尽快到达所有客户端）；
2. **期限即宽限期**：设了 `mandatory_deadline` 时，截止前按普通更新处理
   （可「稍后」，弹窗可关闭，但会显示「请在 … 前完成升级，到期后将无法跳过」）；
   `now >= deadline` 后转为强制，未设期限则立即强制；
   期限解析失败按「已到期」处理，避免格式问题成为绕过手段；
3. **提示（强制生效后）**：弹窗只保留「立即更新」一个按钮，不提供「稍后」，
   也不允许直接关闭；用户取消或退出应用，下次检查继续提示；
4. **原因文案**固定映射四类，客户端不得自行改写：
   `SECURITY` → 安全漏洞修复，`PROTOCOL` → 协议不兼容，
   `REGULATORY` → 法规或税控要求，`MIN_SUPPORTED` → 低于服务端最低支持版本；
   未知值不显示原因，但也不因此判清单无效；
5. 非强制更新的清单不应携带 `mandatory_deadline` / `mandatory_reason`；
   客户端解析时会清空，避免 UI 误显示升级期限。

三端实现位置（口径以本节为准）：小兔 `web/app.js` 的 `mandatoryActive()`、
DevCard `web/app.js` 的同名函数、Mote `modules/update` 的
`mandatoryActive(manifest, now)`。

## 七、安装包命名统一（随 v2 一并执行）

规则：小写、连字符分隔，`<product>-<version>-<os>-<arch>-<type>.<ext>`。

| 旧名（v2 之前） | 新名（v2） |
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
（Mote 在 v2 之前用 windows.json 手工拼接且未签名，切换时已一并补上）。

改完本文件必须跑 `bash tools/release/sync_guard.sh`：它会先跑两个自检，
再把 `guard.py` / `manifest_v2.py` 拷到同级仓库并重算两份 `.sha256`。

### 8.1 事后修改已发布的清单

`resign` 子命令用于**不重新打包**、只改单个字段并整体重签，两个场景：

```bash
# 灰度放量：只改 rollout_percent
python3 tools/release/manifest_v2.py resign --manifest dist/manifest.json \
  --key ~/.config/mote-updates/ed25519_seed.b64 --rollout 60

# 补发/更换说明页：只改 notes_url（自动刷新 updated_at）
python3 tools/release/manifest_v2.py resign --manifest dist/manifest.json \
  --key ~/.config/mote-updates/ed25519_seed.b64 \
  --notes-url https://dl.xiaotu.online/mote/release-notes-1.0.4.html
```

约束：输入必须是已签名清单（拒绝半成品）；`--notes-url` 必须是绝对
`http(s)`；版本、产物 URL / size / sha256、`build` 等字段一律保持原样；
写完自动用私钥推导的公钥自验签。`--platform` 可选
`all` / `macos` / `windows`，默认 `all`。

## 九、改动清单

| 位置 | 改动 |
|---|---|
| `mote/tools/release/manifest_v2.py`（新） | 统一生成 + 签名 + 本地验签，三仓库同步 |
| 三家发布脚本（`publish_macos.sh` / `publish_windows.*`） | 改调 manifest_v2.py，上传 `manifest.json` |
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
