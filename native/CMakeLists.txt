cmake_minimum_required(VERSION 3.25)

# macOS 原生薄外壳（阶段 A）。Qt 构建仍由仓库根的 Mote.pro 负责，两者互不影响。
# 用法：cmake -S native -B build-native && cmake --build build-native

project(MoteNative VERSION 0.0.0 LANGUAGES C CXX OBJCXX)

get_filename_component(MOTE_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(MOTE_PLATFORM_MAC "${MOTE_REPO_ROOT}/platform/mac")

# 版本号唯一来源：Mote.pro 的 VERSION 行
file(READ "${MOTE_REPO_ROOT}/Mote.pro" MOTE_PRO_CONTENT)
if(NOT MOTE_PRO_CONTENT MATCHES "\nVERSION[ \t]*=[ \t]*([0-9]+\\.[0-9]+\\.[0-9]+)")
  message(FATAL_ERROR "无法从 Mote.pro 读取 VERSION")
endif()
set(MOTE_VERSION "${CMAKE_MATCH_1}")

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0")
endif()
if(NOT CMAKE_OSX_ARCHITECTURES)
  set(CMAKE_OSX_ARCHITECTURES "arm64")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OBJCXX_STANDARD 20)

# 前端资源只有一份：直接引用仓库 resources/，构建时拷进 bundle。
set(MOTE_WEB_FILES
  "${MOTE_REPO_ROOT}/resources/web/editor.html"
  "${MOTE_REPO_ROOT}/resources/web/editor.css"
  "${MOTE_REPO_ROOT}/resources/web/editor.js")
set(MOTE_FONT_FILES
  "${MOTE_REPO_ROOT}/resources/fonts/JetBrainsMono-Light.ttf")
set(MOTE_SAMPLE_FILES
  "${MOTE_REPO_ROOT}/resources/samples/welcome.md")
set(MOTE_ICON_FILES
  "${MOTE_REPO_ROOT}/resources/icons/app.icns")

set_source_files_properties(${MOTE_WEB_FILES} PROPERTIES
  MACOSX_PACKAGE_LOCATION "Resources/web")
set_source_files_properties(${MOTE_FONT_FILES} PROPERTIES
  MACOSX_PACKAGE_LOCATION "Resources/fonts")
set_source_files_properties(${MOTE_SAMPLE_FILES} PROPERTIES
  MACOSX_PACKAGE_LOCATION "Resources/samples")
set_source_files_properties(${MOTE_ICON_FILES} PROPERTIES
  MACOSX_PACKAGE_LOCATION "Resources")

set(MOTE_EXECUTABLE_NAME "Mote")
configure_file(
  "${MOTE_PLATFORM_MAC}/Info.plist.in"
  "${CMAKE_CURRENT_BINARY_DIR}/Info.plist"
  @ONLY)

# 无 Qt、无平台 API 的核心：两个构建共用（Qt 构建后续同样接这里的源码）
add_library(mote_core STATIC
  "${MOTE_REPO_ROOT}/core/base64.cpp"
  "${MOTE_REPO_ROOT}/core/command_table.cpp"
  "${MOTE_REPO_ROOT}/core/editor_controller.cpp"
  "${MOTE_REPO_ROOT}/core/image_store.cpp"
  "${MOTE_REPO_ROOT}/core/js_bridge.cpp"
  "${MOTE_REPO_ROOT}/core/json.cpp"
  "${MOTE_REPO_ROOT}/core/paths.cpp")
target_include_directories(mote_core PUBLIC "${MOTE_REPO_ROOT}")
target_compile_options(mote_core PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wall>")

add_executable(Mote MACOSX_BUNDLE
  ${MOTE_PLATFORM_MAC}/main.mm
  ${MOTE_PLATFORM_MAC}/main_window.mm
  ${MOTE_PLATFORM_MAC}/menus.mm
  ${MOTE_PLATFORM_MAC}/dialogs.mm
  ${MOTE_PLATFORM_MAC}/web_host_view.mm
  ${MOTE_WEB_FILES}
  ${MOTE_FONT_FILES}
  ${MOTE_SAMPLE_FILES}
  ${MOTE_ICON_FILES})

target_compile_options(Mote PRIVATE
  "$<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>"
  "$<$<COMPILE_LANGUAGE:CXX>:-Wall>"
  "$<$<COMPILE_LANGUAGE:OBJCXX>:-Wall>")

target_link_libraries(Mote PRIVATE
  mote_core
  "-framework Cocoa"
  "-framework WebKit"
  "-framework UniformTypeIdentifiers")

set_target_properties(Mote PROPERTIES
  MACOSX_BUNDLE_BUNDLE_NAME "Mote"
  MACOSX_BUNDLE_GUI_IDENTIFIER "com.mote.Mote"
  MACOSX_BUNDLE_BUNDLE_VERSION "${MOTE_VERSION}"
  MACOSX_BUNDLE_SHORT_VERSION_STRING "${MOTE_VERSION}"
  MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_BINARY_DIR}/Info.plist")

# 无窗口单测：cmake --build build-native && ctest --test-dir build-native
enable_testing()
add_executable(mote_core_tests tests/core_tests.cpp)
target_link_libraries(mote_core_tests PRIVATE mote_core)
target_compile_options(mote_core_tests PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wall>")
add_test(NAME mote_core_tests COMMAND mote_core_tests)
