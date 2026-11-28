#include "web_host_view.h"

#include "env.h"
#include "win_encoding/encoding.h"

#include "core/inject_chunks.h"
#include "core/js_bridge.h"
#include "core/json.h"
#include "core/perf.h"

#include <shlobj.h>
#include <shlwapi.h>
#include <urlmon.h>
#include <wrl/event.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace {

#include "web_host_view_bridge.inc"
#include "web_host_view_fs.inc"
#include "web_host_view_util.inc"
} // namespace

#include "web_host_view_lifecycle.inc"
#include "web_host_view_init.inc"
#include "web_host_view_page.inc"
#include "web_host_view_eval.inc"
#include "web_host_view_pdf.inc"
#include "web_host_view_inject.inc"
#include "web_host_view_window.inc"
