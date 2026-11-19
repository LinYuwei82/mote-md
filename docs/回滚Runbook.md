# 紧急回滚 Runbook

适用于三个产品：Mote / 小兔 / DevCard。

**前提：** 发布前 `guard.py doctor --product <x> --platform both` 全部就绪；发布机本地保留至少一份可回退版本的清单和产物（推荐在 `dist/rollback/<版本>/` 下归档）。

**签名密钥位置**（三家不同，注意用对）：

| 产品 | Ed25519 签名种子 | Sparkle 签名私钥 |
|---|---|---|
| Mote | `~/.config/mote-updates/ed25519_seed.b64` | `~/.config/mote-updates/sparkle_ed25519_seed.b64` |
| 小兔 | `~/.config/xiaotu-updates/update_signing_2026.pem` | 无（iOS 自研） |
| DevCard | `~/.config/devcard/manifest-keys/ed25519_seed.b64` | `~/.config/devcard/sparkle-keys/private_key.pem` |

---

## 场景一：清单签名/字段错误（安装包本身没问题）

**症状：** 客户端报"清单验签失败"、或者某个平台段的 `notes_url` 写错。

**核心工具：** `manifest_v2.py resign` — **不重新打包**，只改字段并整体重签。

### 1a. 只改 notes_url

```bash
PRODUCT=mote
PRODUCT_DIR=mote   # OSS 桶内子目录
KEY=~/.config/mote-updates/ed25519_seed.b64

# ① 取线上清单
curl -fsSL https://dl.xiaotu.online/$PRODUCT_DIR/updates/stable/manifest.json \
  -o /tmp/manifest-live.json

# ② 改 notes_url（resign 只重签，刷新 updated_at）
python3 tools/release/manifest_v2.py resign --manifest /tmp/manifest-live.json \
  --key $KEY \
  --notes-url https://dl.xiaotu.online/$PRODUCT_DIR/release-notes-1.0.4.html \
  --notes-url-win https://dl.xiaotu.online/$PRODUCT_DIR/release-notes-1.0.4.html

# ③ 自验签
python3 tools/release/manifest_v2.py verify --manifest /tmp/manifest-live.json \
  --pub-hex $(python3 tools/release/manifest_v2.py pubkey --key $KEY | sed 's/.*：//')

# ④ 上传覆盖（OSS 直连，上传即生效）
ossutil -c ~/.config/xiaotu-updates/.env cp /tmp/manifest-live.json \
  oss://xiaotu-update/$PRODUCT_DIR/updates/stable/manifest.json \
  -f

# ⑤ 线上校验
curl -fsSL https://dl.xiaotu.online/$PRODUCT_DIR/updates/stable/manifest.json \
  -o /tmp/manifest-after.json
python3 tools/release/manifest_v2.py verify --manifest /tmp/manifest-after.json \
  --pub-hex $(python3 tools/release/manifest_v2.py pubkey --key $KEY | sed 's/.*：//')
```

### 1b. 改 rollout_percent（灰度放量）

```bash
python3 tools/release/manifest_v2.py resign --manifest /tmp/manifest-live.json \
  --key $KEY --rollout 60
# 同上步骤 ③④⑤
```

### 1c. 换签名密钥

```bash
# 新密钥对应的客户端必须也内置了新公钥才算完成
python3 tools/release/manifest_v2.py resign --manifest /tmp/manifest-live.json \
  --key ~/.config/mote-updates/ed25519_seed_NEW.b64
```

**注意：** `resign` 会拒绝未签名的清单。如果线上清单还没签过，用 `manifest_v2.py generate --prev <path>` 从产物重新生成并整体签。

---

## 场景二：安装包残缺 / 有 bug（清单没问题，但产物本身有问题）

**症状：** 下载后的 DMG 打不开、EXE 被杀毒误报、Sparkle.framework 不在位（见 mote 1.0.4）。

**判断：** 同版本重发（修复产物内容）vs 升版本号（正常发版）

### 2a. 覆盖同名包（immutable 缓存下的快速修复）

OSS 对象标记 `immutable, max-age=31536000`，**同名重传会替换源站**。客户端可能命中浏览器/系统缓存，**仅限紧急修复**，之后必须升版本号发正式版。

```bash
# ① 重新打包（正常流程，略）
# ② 用 publish_macos.sh / publish_windows.sh 按同版本号重发
VERSION=1.0.4
BUILD=202611181542
bash tools/release/publish_macos.sh --version $VERSION
# 或（Windows）
BUILD=$BUILD bash tools/release/publish_windows.sh

# ③ 线上 SHA256 必须变化（guard verify-live 会校验）
python3 tools/release/guard.py verify-live \
  --product mote --kind mac --file dist/Mote-1.0.4-macos-arm64.dmg
```

### 2b. 升版本号（推荐）

按正常发布流程走，直接跳转到下一个 patch 号（如 1.0.4 → 1.0.5）。无需任何回滚操作。

---

## 场景三：整版本回退（最新版本有严重问题，回退到上一个已知好版本）

**前提：** 桶内保留着上一版本的安装包和本地签名过的清单副本（见 OSS-发布布局.md 3.1-3.3 节）。

```bash
PRODUCT=mote
KEY=~/.config/mote-updates/ed25519_seed.b64

# ① 找到上一版本清单（本地 dist/rollback/ 归档，或从旧 tag 恢复）
cp dist/rollback/1.0.3/manifest.json /tmp/manifest-rollback.json

# ② 重签（刷新 updated_at；字段内容与当时签名时保持一致）
python3 tools/release/manifest_v2.py resign --manifest /tmp/manifest-rollback.json \
  --key $KEY

# ③ 可选：替换 notes_url 指向"紧急回退说明页"
python3 tools/release/manifest_v2.py resign --manifest /tmp/manifest-rollback.json \
  --key $KEY \
  --notes-url https://dl.xiaotu.online/$PRODUCT_DIR/release-notes-rollback.html

# ④ 自验签 + 上传（同场景一的步骤 ③④）
# ⑤ 线上校验：客户端会从清单看到 platform.version 下降
```

**回滚后必须做：**
- 仓库 `docs/release-notes-<新版本号>.html` 写清楚"紧急回滚到 vX.Y.Z"的原因和已知限制
- 通知用户 / 企业管理员暂缓自动更新到有问题的版本

---

## 场景四：appcast.xml 需要紧急重签（macOS Sparkle）

Sparkle 2 的 appcast.xml 也有 Ed25519 签名。清单回滚时 appcast 必须同步，否则客户端可能卡在旧 feed。

```bash
PRODUCT=mote
KEY=~/.config/mote-updates/sparkle_ed25519_seed.b64
SPARKLE_BIN=~/.config/mote-updates/bin  # 或下载的 Sparkle 发行包 bin

# ① 取线上 appcast + 重签（用 Sparkle 自带的 sign_update）
curl -fsSL https://dl.xiaotu.online/$PRODUCT_DIR/updates/stable/appcast.xml \
  -o /tmp/appcast-live.xml
$SPARKLE_BIN/sign_update /tmp/appcast-live.xml \
  --key $KEY \
  # (Sparkle 重签会刷新 edSignature，不改变 feed 内容)

# ② 上传覆盖
ossutil -c ~/.config/xiaotu-updates/.env cp /tmp/appcast-live.xml \
  oss://xiaotu-update/$PRODUCT_DIR/updates/stable/appcast.xml \
  -f --headers "Cache-Control:public, max-age=60"
```

---

## 快速决策树

```
线上问题
├── 客户端验签失败 / notes_url 错 → 场景一 resign
├── 安装包有 bug / 残缺
│   ├── 要快速救场、1 小时内 → 场景 2a 覆盖同名
│   └── 能等下一轮正常发版 → 场景 2b 升版本号
├── 最新版本严重问题 → 场景三 回退清单到上一好版本
└── macOS Sparkle appcast 问题 → 场景四 重签 appcast

任何场景完成后必做：
  guard.py verify-live --product X --kind mac/win --file ...
  线上 curl 取清单 + manifest_v2.py verify 自验签
```

## 风险清单

| 风险 | 规避 |
|---|---|
| resign 时用错密钥 → 客户端验签失败 | resign 之后必须 `verify --pub-hex` 自验签 |
| OSS 上传同名包 immutable 缓存导致客户端仍用旧字节 | 紧急修复后 24 小时内必须升版本号发正式版 |
| 回退版本的安装包已从桶清理 | 发布脚本禁止删除上一版本；清理前必须确认有本地归档 |
| resign 覆盖另一平台刚写入的段（并发竞态） | 取线上清单后快速操作；或 `--platform mac` 只改单个平台 |
