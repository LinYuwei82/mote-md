#pragma once

#include <string>
#include <string_view>

namespace mote {

// 更新清单 v2 的 Ed25519 公钥（trust anchor，编译进客户端）。
// hex：9775c126ac2355c0c6b82089560c9428686bc496323f8b0a80a1d4caed610a72，
// 与 Sparkle EdDSA 公钥（native/CMakeLists.txt 的 MOTE_SPARKLE_PUBKEY）是
// 两把独立密钥：清单密钥 2026-11-18 轮换，只用于 manifest.json 签名。
// 私钥只在发布机 ~/.config/mote-updates/（ed25519_seed.b64）；
// 轮换密钥 = 新 key_id + 新公钥随下一个客户端版本发布。
inline constexpr unsigned char kUpdateManifestPublicKey[32] = {
    0x97, 0x75, 0xc1, 0x26, 0xac, 0x23, 0x55, 0xc0, 0xc6, 0xb8, 0x20, 0x89,
    0x56, 0x0c, 0x94, 0x28, 0x68, 0x6b, 0xc4, 0x96, 0x32, 0x3f, 0x8b, 0x0a,
    0x80, 0xa1, 0xd4, 0xca, 0xed, 0x61, 0x0a, 0x72,
};

// 验证 v2 更新清单的 Ed25519 签名（签名规则见 docs/更新清单Schema-v2.md 第四节）：
// 取整个 JSON 对象去掉顶层 signature 字段 → 递归按键名排序、紧凑无空白、UTF-8
// 得到 canonical bytes → TweetNaCl crypto_sign_open 验签（signature 为 base64 的
// 64 字节 Ed25519 签名）。清单不是合法 JSON、缺 signature、signature 长度不对或
// 验签不通过都返回 false，error 给出中文原因。
bool verifyUpdateManifestSignature(std::string_view manifestText,
                                   const unsigned char publicKey[32], std::string *error);

// 计算清单的 canonical bytes（去掉顶层 signature、键排序、紧凑、UTF-8），语义与
// 发布端 Python json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False)
// 逐字节一致。独立暴露是为无窗口单测：单测直接比对发布工具产出的 canonical bytes。
bool canonicalUpdateManifestBytes(std::string_view manifestText, std::string *out,
                                  std::string *error);

} // namespace mote
