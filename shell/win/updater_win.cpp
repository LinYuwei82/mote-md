#include "updater_win.h"

// Windows 更新适配器：只实现「网络 / 持久化 / 原生弹窗 / 下载与安装」，
// 状态机（时机、节流、验签→解析→判定、跳过规则、文案）全部在 mote::UpdateEngine，
// 与 macOS 共用同一份，见 modules/update/include/mote/update_engine.h。

#include "mote/update.h"
#include "mote/update_engine.h"
#include "mote/verify_signature.h"
#include "dialogs.h"
#include "env.h"
#include "win_encoding/encoding.h"

#include <bcrypt.h>
#include <commctrl.h>
#include <shellapi.h>
#include <winhttp.h>

#include <atomic>
#include <chrono>
#include <cctype>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#ifndef MOTE_VERSION
#define MOTE_VERSION "0.0.0"
#endif

// Windows 构建号：发布时由 CMake -DMOTE_BUILD=<seq> 注入（见 native/CMakeLists.txt）。
// 清单同版本时靠 build 判断是否有新构建；0（未知）时跳过 build 比较，仅按 version。
#ifndef MOTE_BUILD
#define MOTE_BUILD 0
#endif

#if !defined(MOTE_BUILD_STR)
#define MOTE_BUILD_STR "0"
#endif

// ---- 二进制内构建号标记（供 guard.py 二次校验）
//
// 发布脚本从 CMakeCache 读出 MOTE_BUILD 写入清单，
// guard.py 上传前扫描绿色包 / setup.exe 里的 EXE 字节，比对清单 build 与
// 本机构建号一致——防止脚本读错 CMakeCache 导致同版本反复提示。
// 必须是 extern "C" 外部符号 + /INCLUDE 强制保留：内部静态数组会被
// MSVC 14.52（CI runner）的死代码消除剥离（1.0.29 实测），[[maybe_unused]]
// 与指针引用都挡不住；x64 下 C 符号无修饰，/INCLUDE 直接写符号名。
#pragma comment(linker, "/INCLUDE:kMoteBuildStamp")
extern "C" const char kMoteBuildStamp[] = "MOTE_BUILD=" MOTE_BUILD_STR;

// 源文件分段：本文件仍是单一编译单元，按域拆成 shell/win/updater_win_*.inc。
// 片段按原顺序拼回，行为与拆分前逐字一致。
namespace mote::win {

namespace {

#include "updater_win_support.inc"
#include "updater_win_checksum.inc"
#include "updater_win_http.inc"
#include "updater_win_flow.inc"
#include "updater_win_adapters.inc"
} // namespace

#include "updater_win_api.inc"

} // namespace mote::win
