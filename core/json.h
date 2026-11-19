#pragma once

#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace mote {

// 前端消息用的最小 JSON 实现：只需要对象/数组/字符串/数字/布尔/空。
// 不引第三方库，macOS 与 Windows 共用同一份解析，保证两端协议完全一致。
class JsonValue
{
public:
    enum class Type { Null, Bool, Number, String, Array, Object };
    using Array = std::vector<JsonValue>;
    using Object = std::map<std::string, JsonValue>;

    JsonValue() = default;
    explicit JsonValue(bool value) : m_type(Type::Bool), m_bool(value) {}
    explicit JsonValue(double value) : m_type(Type::Number), m_number(value) {}
    explicit JsonValue(std::string value) : m_type(Type::String), m_string(std::move(value)) {}
    explicit JsonValue(Array value) : m_type(Type::Array), m_array(std::move(value)) {}
    explicit JsonValue(Object value) : m_type(Type::Object), m_object(std::move(value)) {}

    Type type() const { return m_type; }
    bool isObject() const { return m_type == Type::Object; }
    bool isArray() const { return m_type == Type::Array; }
    bool isString() const { return m_type == Type::String; }

    bool asBool(bool fallback = false) const { return m_type == Type::Bool ? m_bool : fallback; }
    double asNumber(double fallback = 0.0) const { return m_type == Type::Number ? m_number : fallback; }
    const std::string &asString() const;      // 非字符串返回空串
    const Array &asArray() const;
    const Object &asObject() const;

    const JsonValue *find(std::string_view key) const;
    std::string stringAt(std::string_view key, std::string fallback = {}) const;
    bool boolAt(std::string_view key, bool fallback = false) const;
    double numberAt(std::string_view key, double fallback = 0.0) const;

private:
    Type m_type = Type::Null;
    bool m_bool = false;
    double m_number = 0.0;
    std::string m_string;
    Array m_array;
    Object m_object;
};

// 解析整段文本；留有多余字符或语法错误返回 false
bool parseJson(std::string_view text, JsonValue &out);

// 编码成 JSON 字符串字面量（带引号），可直接嵌进 JS
std::string quoteJson(std::string_view text);

} // namespace mote
