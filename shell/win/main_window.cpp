#include "main_window.h"

#include "dialogs.h"
#include "about_dialog.h"
#include "drop_target.h"
#include "env.h"
#include "html_export.h"
#include "menus.h"
#include "pdf_export.h"
#include "updater_win.h"
#include "web_host_view.h"

#include "core/editor_controller.h"
#include "core/js_bridge.h"
#include "core/paths.h"
#include "core/perf.h"
#include "core/recent_files.h"
#include "core/text_encoding.h"
#include "mote/update_engine.h"
#include "win_encoding/encoding.h"

#include <shlobj.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <cctype>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <utility>

// 源文件分段：本文件仍是单一编译单元，按域拆成 shell/win/main_window_*.inc，
// 由下面的 #include 按原顺序拼回。片段里没有额外声明/可见性改动，
// 行为与拆分前逐字一致；新增代码请放进对应片段，不要打乱顺序。
#include "main_window_support.inc"
#include "main_window_window.inc"
#include "main_window_messages.inc"
#include "main_window_message_handlers.inc"
#include "main_window_documents.inc"
#include "main_window_files.inc"
#include "main_window_page.inc"
#include "main_window_commands.inc"
#include "main_window_io.inc"
