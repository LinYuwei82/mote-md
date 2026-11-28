# 按清单（editor.manifest.json / css.manifest.json）的顺序拼接前端分片。
#
# 由 native/CMakeLists.txt 在构建期调用（cmake -P），不依赖 Python/Node：
#   cmake -DMOTE_EDITOR_SRC_DIR=... -DMOTE_EDITOR_MANIFEST=... \
#         -DMOTE_EDITOR_OUT=... -P tools/editor/bundle_editor.cmake
#
# 运行时仍然是单个 editor.js（外壳继续用 __MOTE_JS__ 内联），只是源码拆成了
# 多个文件。拼接必须逐字节等于分片内容之和。

foreach(required MOTE_EDITOR_SRC_DIR MOTE_EDITOR_MANIFEST MOTE_EDITOR_OUT)
  if(NOT DEFINED ${required} OR "${${required}}" STREQUAL "")
    message(FATAL_ERROR "bundle_editor.cmake 缺少参数：${required}")
  endif()
endforeach()

if(NOT EXISTS "${MOTE_EDITOR_MANIFEST}")
  message(FATAL_ERROR "找不到前端分片清单：${MOTE_EDITOR_MANIFEST}")
endif()

file(READ "${MOTE_EDITOR_MANIFEST}" manifest_json)
string(JSON part_count LENGTH "${manifest_json}" files)
if(part_count EQUAL 0)
  message(FATAL_ERROR "前端分片清单 files 为空：${MOTE_EDITOR_MANIFEST}")
endif()

set(bundle "")
math(EXPR last_index "${part_count} - 1")
foreach(index RANGE 0 ${last_index})
  string(JSON part_name GET "${manifest_json}" files ${index})
  set(part_path "${MOTE_EDITOR_SRC_DIR}/${part_name}")
  if(NOT EXISTS "${part_path}")
    message(FATAL_ERROR "前端分片缺失：${part_path}")
  endif()
  file(READ "${part_path}" part_text)
  string(APPEND bundle "${part_text}")
endforeach()

get_filename_component(out_dir "${MOTE_EDITOR_OUT}" DIRECTORY)
file(MAKE_DIRECTORY "${out_dir}")
file(WRITE "${MOTE_EDITOR_OUT}" "${bundle}")
