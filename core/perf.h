#pragma once

// 启动 / 打开文件链路计时打点（步骤 0：先测后改）。
// 仅在环境变量 MOTE_PERF=1 时输出，默认零开销（一次 static bool 判断）。
// 用法：在进程起点调用 mote::perfReset()，各里程碑调用 mote::perfMark("tag")，
// 输出形如 "[perf] tag  +123.4ms (Δ 45.6ms)" 到 stderr。

#include <chrono>
#include <cstdio>
#include <cstdlib>

namespace mote {

inline bool perfEnabled()
{
#if defined(_MSC_VER)
    static const bool enabled = [] {
        char *raw = nullptr;
        std::size_t size = 0;
        const bool on = _dupenv_s(&raw, &size, "MOTE_PERF") == 0 && raw != nullptr;
        std::free(raw);
        return on;
    }();
    return enabled;
#else
    static const bool enabled = std::getenv("MOTE_PERF") != nullptr;
    return enabled;
#endif
}

inline std::chrono::steady_clock::time_point &perfOrigin()
{
    static std::chrono::steady_clock::time_point origin = std::chrono::steady_clock::now();
    return origin;
}

inline double &perfLast()
{
    static double last = 0.0;
    return last;
}

inline void perfReset()
{
    if (perfEnabled()) {
        perfOrigin() = std::chrono::steady_clock::now();
        perfLast() = 0.0;
    }
}

inline void perfMark(const char *tag)
{
    if (!perfEnabled())
        return;
    const auto now = std::chrono::steady_clock::now();
    const double total = std::chrono::duration<double, std::milli>(now - perfOrigin()).count();
    const double delta = total - perfLast();
    perfLast() = total;
    std::fprintf(stderr, "[perf] %-22s %9.1fms  (Δ %8.1fms)\n", tag, total, delta);
    std::fflush(stderr);
}

} // namespace mote
