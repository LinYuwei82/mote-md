#include "core/editor_controller.h"

#include "core/base64.h"
#include "core/image_store.h"
#include "core/inject_chunks.h"
#include "core/js_bridge.h"
#include "core/json.h"
#include "core/paths.h"
#include "core/perf.h"

#include <filesystem>

namespace mote {

namespace {
// 单条脚本体积预算：与 win 壳通道一同口径，超出则走分片，避免
// 一次性把整篇正文塞进一条 evaluateJavaScript 阻塞页面主线程。
constexpr std::size_t kScriptBudget = 512 * 1024;
} // namespace

#include "editor_controller_host.inc"
#include "editor_controller_scope.inc"
#include "editor_controller_docs.inc"
#include "editor_controller_inject.inc"
#include "editor_controller_edit.inc"
#include "editor_controller_view.inc"
#include "editor_controller_format.inc"
#include "editor_controller_images.inc"
#include "editor_controller_drop.inc"
#include "editor_controller_message.inc"
} // namespace mote
