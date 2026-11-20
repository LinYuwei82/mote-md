# mote_update：自动更新模块（独立 STATIC library）
#
# 职责：版本比较（decideUpdate）、灰度分桶（sha256）+ manifest v2 Ed25519 验签。
# 平台桥接层（platform/mac/updater.mm、platform/win/updater.cpp）link 本 target
# 拿到这两个能力。本 target 不依赖任何平台 API，可跨项目复用。
#
# 依赖：mote_core（json + base64，manifest 解析 + base64 编解码）、
#       mote_tweetnacl（纯 C Ed25519，无外部依赖）。

add_library(mote_update STATIC
  "${CMAKE_CURRENT_SOURCE_DIR}/src/update.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/sha256.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/src/verify_signature.cpp")

# 暴露 include/mote/ 给外部项目（#include "mote/update.h"）
# 同时暴露 repo 根目录（内部 #include "core/json.h" 等）
target_include_directories(mote_update PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
  "${MOTE_REPO_ROOT}")

target_link_libraries(mote_update PUBLIC mote_core mote_tweetnacl)

if(MSVC)
  target_compile_options(mote_update PRIVATE /utf-8 /W4)
else()
  target_compile_options(mote_update PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wall>")
endif()
