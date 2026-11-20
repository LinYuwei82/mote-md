#include "mote/verify_signature.h"

#include "core/base64.h"
#include "core/json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

// TweetNaCl 是纯 C 上游（无 extern "C" 守卫），这里包一层供 C++ 调用。
extern "C" {
#include "tweetnacl.h"
}

namespace mote {

namespace {

// TweetNaCl 只在 crypto_sign_keypair 里调用 randombytes；客户端只验签不生成
// 密钥。提供一个显式中止的桩，避免链接错误；万一被调用立即失败，不产出弱密钥。
extern "C" void randombytes(unsigned char *, unsigned long long)
{
    std::fputs("randombytes 不应被调用（客户端只用 crypto_sign_open）\n", stderr);
    std::abort();
}

// 与发布端 json.dumps(ensure_ascii=False, sort_keys=True, separators=(",",":"))
// 逐字节一致：
//   - 键排序：JsonValue::Object 用 std::map<std::string>，按 UTF-8 字节序排列，
//     等价于 Python 的 Unicode 码点排序（UTF-8 编码保持码点顺序）；
//   - 字符串：quoteJson 只转义引号、反斜杠与 <0x20 控制字符，非 ASCII 原样以
//     UTF-8 输出（与 ensure_ascii=False 一致）；
//   - 数字：schema 里的数字全是整数（build/size/manifest_version 等，均
//     < 2^53，double 精确表示），整数值不带小数点输出，与 Python 对 int 的
//     输出一致；带小数的值按「最短往返」表示输出（v2 清单不会出现；真出现且
//     序列化不一致时只会让验签失败，安全地拒绝）。
void appendCanonicalNumber(double value, std::string &out)
{
    char buffer[40];
    if (std::isfinite(value) && value == std::floor(value) && std::fabs(value) < 9.007199254740992e15) {
        std::snprintf(buffer, sizeof(buffer), "%lld", static_cast<long long>(value));
        out += buffer;
        return;
    }
    for (int precision = 1; precision <= 17; ++precision) {
        std::snprintf(buffer, sizeof(buffer), "%.*g", precision, value);
        if (std::strtod(buffer, nullptr) == value)
            break;
    }
    out += buffer;
}

void serializeCanonical(const JsonValue &value, std::string &out)
{
    switch (value.type()) {
    case JsonValue::Type::Null:
        out += "null";
        break;
    case JsonValue::Type::Bool:
        out += value.asBool() ? "true" : "false";
        break;
    case JsonValue::Type::Number:
        appendCanonicalNumber(value.asNumber(), out);
        break;
    case JsonValue::Type::String:
        out += quoteJson(value.asString());
        break;
    case JsonValue::Type::Array: {
        out += '[';
        bool first = true;
        for (const JsonValue &item : value.asArray()) {
            if (!first)
                out += ',';
            first = false;
            serializeCanonical(item, out);
        }
        out += ']';
        break;
    }
    case JsonValue::Type::Object: {
        out += '{';
        bool first = true;
        for (const auto &entry : value.asObject()) { // std::map 已按键名排序
            if (!first)
                out += ',';
            first = false;
            out += quoteJson(entry.first);
            out += ':';
            serializeCanonical(entry.second, out);
        }
        out += '}';
        break;
    }
    }
}

void setError(std::string *error, const char *message)
{
    if (error)
        *error = message;
}

} // namespace

bool canonicalUpdateManifestBytes(std::string_view manifestText, std::string *out,
                                  std::string *error)
{
    JsonValue root;
    if (!parseJson(manifestText, root) || !root.isObject()) {
        setError(error, "更新清单不是合法的 JSON 对象");
        return false;
    }

    // 签名覆盖整个对象去掉顶层 signature 字段后的 canonical bytes；其余字段
    // （包括未知字段）全部原样参与。
    out->clear();
    out->push_back('{');
    bool first = true;
    for (const auto &entry : root.asObject()) {
        if (entry.first == "signature")
            continue;
        if (!first)
            out->push_back(',');
        first = false;
        *out += quoteJson(entry.first);
        out->push_back(':');
        serializeCanonical(entry.second, *out);
    }
    out->push_back('}');
    return true;
}

bool verifyUpdateManifestSignature(std::string_view manifestText,
                                   const unsigned char publicKey[32], std::string *error)
{
    JsonValue root;
    if (!parseJson(manifestText, root) || !root.isObject()) {
        setError(error, "更新清单不是合法的 JSON 对象");
        return false;
    }

    const JsonValue *signature = root.find("signature");
    if (!signature || !signature->isString() || signature->asString().empty()) {
        setError(error, "更新清单缺少 signature");
        return false;
    }
    const std::vector<std::uint8_t> decoded = base64Decode(signature->asString());
    if (decoded.size() != 64) {
        setError(error, "更新清单的 signature 不是 64 字节 Ed25519 签名");
        return false;
    }

    std::string canonical;
    if (!canonicalUpdateManifestBytes(manifestText, &canonical, error))
        return false;

    // TweetNaCl 验签输入是「签名(64B) || 消息」连成的 signed message。
    // 注意：crypto_sign_open 内部先把整个 signed message 拷进 m 缓冲再校验
    // （tweetnacl.c crypto_sign_open L806），所以 m 必须按 smlen 分配，
    // 而不是 smlen-64。
    std::vector<unsigned char> signedMessage;
    signedMessage.reserve(64 + canonical.size());
    signedMessage.insert(signedMessage.end(), decoded.begin(), decoded.end());
    signedMessage.insert(signedMessage.end(), canonical.begin(), canonical.end());
    std::vector<unsigned char> message(signedMessage.size());
    unsigned long long messageLength = 0;
    if (crypto_sign_open(message.data(), &messageLength, signedMessage.data(),
                         static_cast<unsigned long long>(signedMessage.size()),
                         publicKey)
        != 0) {
        setError(error, "更新清单签名验证失败（公钥不匹配或清单被改动）");
        return false;
    }
    return true;
}

} // namespace mote
