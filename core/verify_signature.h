#pragma once

#include <string>
#include <string_view>

namespace mote {

// 更新清单 v2 的 Ed25519 公钥（trust anchor，编译进客户端）。
// hex：1e0083bd6d0c437d87160b90fe35b97d5b5087be2506c5ccb327e8d2c44b1f56，
// 与 Sparkle EdDSA 公钥（native/CMakeLists.txt 的 MOTE_SPARKLE_PUBKEY）是同一
// 密钥对。私钥只在发布机
// ~/.config/mote-updates/；轮换密钥 = 新 key_id + 新公钥随下一个客户端版本发布。
inline constexpr unsigned char kUpdateManifestPublicKey[32] = {
    0x1e, 0x00, 0x83, 0xbd, 0x6d, 0x0c, 0x43, 0x7d, 0x87, 0x16, 0x0b, 0x90,
    0xfe, 0x35, 0xb9, 0x7d, 0x5b, 0x50, 0x87, 0xbe, 0x25, 0x06, 0xc5, 0xcc,
    0xb3, 0x27, 0xe8, 0xd2, 0xc4, 0x4b, 0x1f, 0x56,
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
