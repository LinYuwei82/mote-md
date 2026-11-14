#include "core/json.h"

#include <cstdlib>

namespace mote {

namespace {

const std::string kEmptyString;
const JsonValue::Array kEmptyArray;
const JsonValue::Object kEmptyObject;

constexpr int kMaxDepth = 64;

bool isDigit(char c) { return c >= '0' && c <= '9'; }

void appendUtf8(std::string &out, unsigned int code)
{
    if (code <= 0x7F) {
        out.push_back(static_cast<char>(code));
    } else if (code <= 0x7FF) {
        out.push_back(static_cast<char>(0xC0 | (code >> 6)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else if (code <= 0xFFFF) {
        out.push_back(static_cast<char>(0xE0 | (code >> 12)));
        out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (code >> 18)));
        out.push_back(static_cast<char>(0x80 | ((code >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
}

int hexDigit(char c)
{
    if (c >= '0' && c <= '9')
        return c - '0';
    if (c >= 'a' && c <= 'f')
        return c - 'a' + 10;
    if (c >= 'A' && c <= 'F')
        return c - 'A' + 10;
    return -1;
}

class Parser
{
public:
    explicit Parser(std::string_view text) : m_text(text) {}

    bool parse(JsonValue &out)
    {
        skipSpace();
        if (!parseValue(out, 0))
            return false;
        skipSpace();
        return m_pos == m_text.size();
    }

private:
    void skipSpace()
    {
        while (m_pos < m_text.size()) {
            const char c = m_text[m_pos];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r')
                ++m_pos;
            else
                break;
        }
    }

    bool consume(char expected)
    {
        if (m_pos < m_text.size() && m_text[m_pos] == expected) {
            ++m_pos;
            return true;
        }
        return false;
    }

    bool parseValue(JsonValue &out, int depth)
    {
        if (depth > kMaxDepth || m_pos >= m_text.size())
            return false;
        const char c = m_text[m_pos];
        if (c == '{')
            return parseObject(out, depth);
        if (c == '[')
            return parseArray(out, depth);
        if (c == '"') {
            std::string text;
            if (!parseString(text))
                return false;
            out = JsonValue(std::move(text));
            return true;
        }
        if (c == 't') {
            if (m_text.substr(m_pos, 4) != "true")
                return false;
            m_pos += 4;
            out = JsonValue(true);
            return true;
        }
        if (c == 'f') {
            if (m_text.substr(m_pos, 5) != "false")
                return false;
            m_pos += 5;
            out = JsonValue(false);
            return true;
        }
        if (c == 'n') {
            if (m_text.substr(m_pos, 4) != "null")
                return false;
            m_pos += 4;
            out = JsonValue();
            return true;
        }
        return parseNumber(out);
    }

    bool parseNumber(JsonValue &out)
    {
        const size_t start = m_pos;
        if (m_pos < m_text.size() && (m_text[m_pos] == '-' || m_text[m_pos] == '+'))
            ++m_pos;
        while (m_pos < m_text.size()
               && (isDigit(m_text[m_pos]) || m_text[m_pos] == '.' || m_text[m_pos] == 'e'
                   || m_text[m_pos] == 'E' || m_text[m_pos] == '-' || m_text[m_pos] == '+')) {
            ++m_pos;
        }
        if (m_pos == start)
            return false;
        // strtod 需要以 '\0' 结尾的缓冲：数字部分都很短，拷一份即可
        const std::string token(m_text.substr(start, m_pos - start));
        char *end = nullptr;
        const double value = std::strtod(token.c_str(), &end);
        if (end == token.c_str() || *end != '\0')
            return false;
        out = JsonValue(value);
        return true;
    }

    bool parseString(std::string &out)
    {
        if (!consume('"'))
            return false;
        out.clear();
        while (m_pos < m_text.size()) {
            const char c = m_text[m_pos++];
            if (c == '"')
                return true;
            if (static_cast<unsigned char>(c) < 0x20)
                return false;
            if (c != '\\') {
                out.push_back(c);
                continue;
            }
            if (m_pos >= m_text.size())
                return false;
            const char escape = m_text[m_pos++];
            switch (escape) {
            case '"': out.push_back('"'); break;
            case '\\': out.push_back('\\'); break;
            case '/': out.push_back('/'); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u': {
                unsigned int code = 0;
                if (!parseHex4(code))
                    return false;
                // 代理对：高位后必须紧跟 \uDC00-\uDFFF
                if (code >= 0xD800 && code <= 0xDBFF) {
                    if (m_pos + 1 >= m_text.size() || m_text[m_pos] != '\\'
                        || m_text[m_pos + 1] != 'u')
                        return false;
                    m_pos += 2;
                    unsigned int low = 0;
                    if (!parseHex4(low) || low < 0xDC00 || low > 0xDFFF)
                        return false;
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                }
                appendUtf8(out, code);
                break;
            }
            default:
                return false;
            }
        }
        return false;
    }

    bool parseHex4(unsigned int &out)
    {
        if (m_pos + 4 > m_text.size())
            return false;
        unsigned int value = 0;
        for (int i = 0; i < 4; ++i) {
            const int digit = hexDigit(m_text[m_pos + i]);
            if (digit < 0)
                return false;
            value = value * 16 + static_cast<unsigned int>(digit);
        }
        m_pos += 4;
        out = value;
        return true;
    }

    bool parseArray(JsonValue &out, int depth)
    {
        if (!consume('['))
            return false;
        JsonValue::Array items;
        skipSpace();
        if (consume(']')) {
            out = JsonValue(std::move(items));
            return true;
        }
        while (true) {
            skipSpace();
            JsonValue item;
            if (!parseValue(item, depth + 1))
                return false;
            items.push_back(std::move(item));
            skipSpace();
            if (consume(']')) {
                out = JsonValue(std::move(items));
                return true;
            }
            if (!consume(','))
                return false;
        }
    }

    bool parseObject(JsonValue &out, int depth)
    {
        if (!consume('{'))
            return false;
        JsonValue::Object members;
        skipSpace();
        if (consume('}')) {
            out = JsonValue(std::move(members));
            return true;
        }
        while (true) {
            skipSpace();
            std::string key;
            if (!parseString(key))
                return false;
            skipSpace();
            if (!consume(':'))
                return false;
            skipSpace();
            JsonValue value;
            if (!parseValue(value, depth + 1))
                return false;
            members[std::move(key)] = std::move(value);
            skipSpace();
            if (consume('}')) {
                out = JsonValue(std::move(members));
                return true;
            }
            if (!consume(','))
                return false;
        }
    }

    std::string_view m_text;
    size_t m_pos = 0;
};

} // namespace

const std::string &JsonValue::asString() const
{
    return m_type == Type::String ? m_string : kEmptyString;
}

const JsonValue::Array &JsonValue::asArray() const
{
    return m_type == Type::Array ? m_array : kEmptyArray;
}

const JsonValue::Object &JsonValue::asObject() const
{
    return m_type == Type::Object ? m_object : kEmptyObject;
}

const JsonValue *JsonValue::find(std::string_view key) const
{
    if (m_type != Type::Object)
        return nullptr;
    const auto it = m_object.find(std::string(key));
    return it == m_object.end() ? nullptr : &it->second;
}

std::string JsonValue::stringAt(std::string_view key, std::string fallback) const
{
    const JsonValue *value = find(key);
    return value && value->isString() ? value->asString() : std::move(fallback);
}

bool JsonValue::boolAt(std::string_view key, bool fallback) const
{
    const JsonValue *value = find(key);
    return value ? value->asBool(fallback) : fallback;
}

double JsonValue::numberAt(std::string_view key, double fallback) const
{
    const JsonValue *value = find(key);
    return value ? value->asNumber(fallback) : fallback;
}

bool parseJson(std::string_view text, JsonValue &out)
{
    return Parser(text).parse(out);
}

std::string quoteJson(std::string_view text)
{
    std::string out;
    out.reserve(text.size() + 2);
    out.push_back('"');
    for (const char c : text) {
        const unsigned char byte = static_cast<unsigned char>(c);
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (byte < 0x20) {
                static const char kHex[] = "0123456789abcdef";
                out += "\\u00";
                out.push_back(kHex[byte >> 4]);
                out.push_back(kHex[byte & 0x0F]);
            } else {
                out.push_back(c);
            }
            break;
        }
    }
    out.push_back('"');
    return out;
}

} // namespace mote
