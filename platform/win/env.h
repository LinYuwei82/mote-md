#pragma once

#include <cstddef>
#include <cstdlib>
#include <string>

// 读取 MOTE_* 诊断开关。MSVC 把 getenv 标为弃用（C4996），改用会拷贝一份的
// _dupenv_s 并负责释放；其它平台继续用 getenv。
// 未设置与空串都返回空串，调用方保持原来的 `!empty()` 判断，语义不变。
inline std::string env_value(const char *name)
{
#if defined(_MSC_VER)
    char *raw = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&raw, &size, name) != 0 || !raw)
        return std::string();
    const std::string value(raw);
    std::free(raw);
    return value;
#else
    const char *raw = std::getenv(name);
    return raw ? std::string(raw) : std::string();
#endif
}
