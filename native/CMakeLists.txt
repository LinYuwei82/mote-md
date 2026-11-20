cmake_minimum_required(VERSION 3.25)

# 原生薄外壳：macOS（AppKit + WKWebView）与 Windows（Win32 + WebView2）。
# 用法：cmake -S native -B build-native && cmake --build build-native

if(WIN32)
  project(MoteNative VERSION 0.0.0 LANGUAGES C CXX)
else()
  project(MoteNative VERSION 0.0.0 LANGUAGES C CXX OBJCXX)
endif()

get_filename_component(MOTE_REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)
set(MOTE_PLATFORM_MAC "${MOTE_REPO_ROOT}/platform/mac")
set(MOTE_PLATFORM_WIN "${MOTE_REPO_ROOT}/platform/win")

# 版本号唯一来源：仓库根的 VERSION.txt（单行 x.y.z）
file(STRINGS "${MOTE_REPO_ROOT}/VERSION.txt" MOTE_VERSION LIMIT_COUNT 1)
if(NOT MOTE_VERSION MATCHES "^[0-9]+\\.[0-9]+\\.[0-9]+$")
  message(FATAL_ERROR "无法从 VERSION.txt 读取版本号")
endif()

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# 静态链接 MSVC 运行库（/MT），避免目标机缺 MSVCP140/VCRUNTIME140
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# TweetNaCl（公有领域，上游原样引入）：v2 更新清单的 Ed25519 验签。
# 独立静态库，避免工程级告警选项影响第三方源码；客户端只用 crypto_sign_open。
add_library(mote_tweetnacl STATIC
  "${MOTE_REPO_ROOT}/core/third_party/tweetnacl/tweetnacl.c")
target_include_directories(mote_tweetnacl PUBLIC
  "${MOTE_REPO_ROOT}/core/third_party/tweetnacl")

# 无平台 API 的核心：macOS 与 Windows 共用
add_library(mote_core STATIC
  "${MOTE_REPO_ROOT}/core/base64.cpp"
  "${MOTE_REPO_ROOT}/core/block_layout.cpp"
  "${MOTE_REPO_ROOT}/core/command_table.cpp"
  "${MOTE_REPO_ROOT}/core/editor_controller.cpp"
  "${MOTE_REPO_ROOT}/core/image_store.cpp"
  "${MOTE_REPO_ROOT}/core/inject_chunks.cpp"
  "${MOTE_REPO_ROOT}/core/js_bridge.cpp"
  "${MOTE_REPO_ROOT}/core/json.cpp"
  "${MOTE_REPO_ROOT}/core/paths.cpp"
  "${MOTE_REPO_ROOT}/core/text_encoding.cpp"
  "${MOTE_REPO_ROOT}/core/update.cpp"
  "${MOTE_REPO_ROOT}/core/verify_signature.cpp")
target_include_directories(mote_core PUBLIC "${MOTE_REPO_ROOT}")
target_link_libraries(mote_core PUBLIC mote_tweetnacl)

if(MSVC)
  target_compile_options(mote_core PRIVATE /utf-8 /W4)
else()
  target_compile_options(mote_core PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wall>")
endif()

# 无窗口单测：cmake --build build-native && ctest --test-dir build-native
enable_testing()
add_executable(mote_core_tests tests/core_tests.cpp)
target_link_libraries(mote_core_tests PRIVATE mote_core)
if(MSVC)
  target_compile_options(mote_core_tests PRIVATE /utf-8 /W4)
else()
  target_compile_options(mote_core_tests PRIVATE "$<$<COMPILE_LANGUAGE:CXX>:-Wall>")
endif()
add_test(NAME mote_core_tests COMMAND mote_core_tests)

if(WIN32)
  # ---------------------------------------------------------------- Windows
  set(MOTE_WEBVIEW2_SDK "$ENV{WEBVIEW2_SDK}")
  if(NOT MOTE_WEBVIEW2_SDK)
    set(MOTE_WEBVIEW2_SDK "C:/dev/webview2sdk/pkg")
  endif()
  if(NOT EXISTS "${MOTE_WEBVIEW2_SDK}/build/native/include/WebView2.h")
    message(FATAL_ERROR
      "未找到 WebView2 SDK：请设置 WEBVIEW2_SDK，或把 NuGet 包解压到 C:/dev/webview2sdk/pkg")
  endif()

  string(REPLACE "." ";" MOTE_VERSION_PARTS "${MOTE_VERSION}")
  list(GET MOTE_VERSION_PARTS 0 MOTE_VERSION_MAJOR)
  list(GET MOTE_VERSION_PARTS 1 MOTE_VERSION_MINOR)
  list(GET MOTE_VERSION_PARTS 2 MOTE_VERSION_PATCH)
  set(MOTE_VERSION_COMMA
    "${MOTE_VERSION_MAJOR},${MOTE_VERSION_MINOR},${MOTE_VERSION_PATCH}")
  set(MOTE_WIN_ICON "${MOTE_REPO_ROOT}/resources/win/app.ico")
  # rc.exe 以 .rc 所在目录解析相对路径：把图标拷到生成目录，避免绝对路径转义
  configure_file("${MOTE_WIN_ICON}" "${CMAKE_CURRENT_BINARY_DIR}/app.ico" COPYONLY)
  configure_file("${MOTE_PLATFORM_WIN}/app.manifest" "${CMAKE_CURRENT_BINARY_DIR}/app.manifest" COPYONLY)
  configure_file(
    "${MOTE_PLATFORM_WIN}/app.rc.in"
    "${CMAKE_CURRENT_BINARY_DIR}/app.rc"
    @ONLY)

  add_executable(Mote WIN32
    "${MOTE_PLATFORM_WIN}/main.cpp"
    "${MOTE_PLATFORM_WIN}/main_window.cpp"
    "${MOTE_PLATFORM_WIN}/menus.cpp"
    "${MOTE_PLATFORM_WIN}/drop_target.cpp"
    "${MOTE_PLATFORM_WIN}/dialogs.cpp"
    "${MOTE_PLATFORM_WIN}/html_export.cpp"
    "${MOTE_PLATFORM_WIN}/pdf_export.cpp"
    "${MOTE_PLATFORM_WIN}/updater.cpp"
    "${MOTE_PLATFORM_WIN}/web_host_view.cpp"
    "${CMAKE_CURRENT_BINARY_DIR}/app.rc")

  target_include_directories(Mote PRIVATE
    "${MOTE_WEBVIEW2_SDK}/build/native/include")
  target_link_libraries(Mote PRIVATE
    mote_core user32 gdi32 ole32 oleaut32 uuid advapi32 shlwapi shell32 comctl32
    urlmon windowscodecs winhttp bcrypt)
  # Windows 构建号：同版本清单靠 build 判断是否有新构建；默认 0（未知，跳过
  # build 比较仅按 version），发布脚本用 -DMOTE_BUILD=202611180530 覆盖。
  # 同时以字符串形式注入 MOTE_BUILD_STR（纯前 12 位数字，保持客户端整数比较兼容）
  # 和 MOTE_BUILD_HASH（短 git hash，可选，用于发布追溯）。updater.cpp 会在二进制里
  # 留一条 "MOTE_BUILD=<digits>" 的可搜索 pattern——guard.py preflight 发布
  # 时会 grep 绿色包/安装包里的 Mote.exe，与 --build 参数比对，防止清单 build
  # 与编译值不一致导致客户端反复提示同一版本（2026-11-19 mote 1.0.4 即因此重发）。
  if(NOT MOTE_BUILD)
    set(MOTE_BUILD "0")
  endif()
  if(NOT MOTE_BUILD_HASH)
    set(MOTE_BUILD_HASH "")
  endif()
  # 带 hash 的完整 stamp（仅用于二进制内搜索和追溯），与数字版 MOTE_BUILD 分离
  if(MOTE_BUILD_HASH)
    set(MOTE_BUILD_STAMP "${MOTE_BUILD}-${MOTE_BUILD_HASH}")
  else()
    set(MOTE_BUILD_STAMP "${MOTE_BUILD}")
  endif()
  target_compile_definitions(Mote PRIVATE
    UNICODE _UNICODE NOMINMAX _WIN32_WINNT=0x0A00
    MOTE_VERSION="${MOTE_VERSION}"
    MOTE_BUILD=${MOTE_BUILD}
    MOTE_BUILD_STR="${MOTE_BUILD_STAMP}")
  target_compile_options(Mote PRIVATE /utf-8 /W4 /permissive-)
  # 关闭链接器自动生成的 manifest，改用 app.manifest（Common Controls v6）
  target_link_options(Mote PRIVATE /MANIFEST:NO)

  # 前端资源只有一份：构建时拷到 exe 同级，运行时按 exe 目录定位
  add_custom_command(TARGET Mote POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:Mote>/web"
    COMMAND ${CMAKE_COMMAND} -E copy_directory
      "${MOTE_REPO_ROOT}/resources/web" "$<TARGET_FILE_DIR:Mote>/web"
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:Mote>/fonts"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${MOTE_REPO_ROOT}/resources/fonts/JetBrainsMono-Light.ttf"
      "$<TARGET_FILE_DIR:Mote>/fonts/JetBrainsMono-Light.ttf"
    COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:Mote>/samples"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${MOTE_REPO_ROOT}/resources/samples/welcome.md"
      "$<TARGET_FILE_DIR:Mote>/samples/welcome.md")

  set(MOTE_WEBVIEW2_LOADER "${MOTE_WEBVIEW2_SDK}/build/native/x64/WebView2Loader.dll")
  if(EXISTS "${MOTE_WEBVIEW2_LOADER}")
    add_custom_command(TARGET Mote POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${MOTE_WEBVIEW2_LOADER}" "$<TARGET_FILE_DIR:Mote>/WebView2Loader.dll")
  else()
    message(WARNING "未找到 ${MOTE_WEBVIEW2_LOADER}，运行时需手动提供 WebView2Loader.dll")
  endif()
else()
  # ------------------------------------------------------------------ macOS
  if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "14.0")
  endif()
  if(NOT CMAKE_OSX_ARCHITECTURES)
    set(CMAKE_OSX_ARCHITECTURES "arm64")
  endif()
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

  # Sparkle 自动更新（纯 Sparkle 方案：Info.plist 键 + framework 拷贝 + 一行初始化）
  # 历史踩坑：检测到缺失时只 WARNING 继续构建，最终 DMG 缺 framework → 自动更新退化
  # 为浏览器下载（2026-11-19 mote 1.0.4 即因此重发）。默认 WARNING 兼容开发机本地跑不
  # 起来 Sparkle 的场景；发布脚本 / CI 传 -DMOTE_STRICT_BUILD=ON 升级为 FATAL_ERROR。
  set(MOTE_SPARKLE_FRAMEWORK "${MOTE_REPO_ROOT}/resources/Sparkle.framework")

  # Sparkle 2.x 的 tarball 缺 Versions/Current 符号链接（已知缺陷）。
  # 顶层链接 Sparkle -> Versions/Current/Sparkle 如果 Current 不存在会整体断链。
  # 这里自动探测 Versions 下唯一的版本子目录（如 B / C / D …），创建 Current -> <letter> 链接。
  # 这样任何人在任何新机器 setup Sparkle 都不用手动操作。
  if(IS_DIRECTORY "${MOTE_SPARKLE_FRAMEWORK}" AND
     NOT EXISTS "${MOTE_SPARKLE_FRAMEWORK}/Versions/Current" AND
     IS_DIRECTORY "${MOTE_SPARKLE_FRAMEWORK}/Versions")
    file(GLOB SPARKLE_VERSIONS RELATIVE "${MOTE_SPARKLE_FRAMEWORK}/Versions"
         "${MOTE_SPARKLE_FRAMEWORK}/Versions/*")
    list(FILTER SPARKLE_VERSIONS EXCLUDE REGEX "^Current$")
    list(LENGTH SPARKLE_VERSIONS SPARKLE_VER_COUNT)
    if(SPARKLE_VER_COUNT EQUAL 1)
      list(GET SPARKLE_VERSIONS 0 SPARKLE_VER)
      message(STATUS "Sparkle.framework: 自动补建 Versions/Current -> ${SPARKLE_VER} 符号链接（Sparkle tarball 已知缺陷）")
      file(CREATE_LINK "${SPARKLE_VER}" "${MOTE_SPARKLE_FRAMEWORK}/Versions/Current" SYMBOLIC)
    elseif(SPARKLE_VER_COUNT GREATER 1)
      message(WARNING "Sparkle.framework Versions 下有多个目录：${SPARKLE_VERSIONS}，请手动指定 Current")
    endif()
  endif()

  if(NOT EXISTS "${MOTE_SPARKLE_FRAMEWORK}/Sparkle")
    if(MOTE_STRICT_BUILD)
      message(FATAL_ERROR
        "MOTE_STRICT_BUILD=ON 但未找到 Sparkle.framework（期望在 ${MOTE_SPARKLE_FRAMEWORK}）。"
        "发布流程要求 Sparkle.framework 必须存在，否则自动更新将退化为打开浏览器下载。"
        "下载：https://github.com/sparkle-project/Sparkle/releases")
    else()
      message(WARNING
        "未找到 Sparkle.framework（期望在 ${MOTE_SPARKLE_FRAMEWORK}），"
        "自动更新将被禁用。下载地址："
        "https://github.com/sparkle-project/Sparkle/releases")
    endif()
    set(MOTE_SPARKLE_ENABLED OFF)
  else()
    set(MOTE_SPARKLE_ENABLED ON)
  endif()

  # appcast 托管 URL；发布脚本可以通过 -DSPARKLE_FEED_URL=... 覆盖
  if(NOT SPARKLE_FEED_URL)
    set(SPARKLE_FEED_URL "https://dl.xiaotu.online/mote/updates/stable/appcast.xml")
  endif()

  # 更新包 EdDSA 验签公钥（Sparkle 2 必填）。对应私钥在发布机
  # ~/.config/mote-updates/，不随仓库分发。
  if(NOT MOTE_SPARKLE_PUBKEY)
    set(MOTE_SPARKLE_PUBKEY "HgCDvW0MQ32HFguQ/jW5fVtQh74lBsXMsyfo0sRLH1Y=")
  endif()

  set(MOTE_EXECUTABLE_NAME "Mote")
  configure_file(
    "${MOTE_PLATFORM_MAC}/Info.plist.in"
    "${CMAKE_CURRENT_BINARY_DIR}/Info.plist"
    @ONLY)

  add_executable(Mote MACOSX_BUNDLE
    ${MOTE_PLATFORM_MAC}/main.mm
    ${MOTE_PLATFORM_MAC}/main_window.mm
    ${MOTE_PLATFORM_MAC}/menus.mm
    ${MOTE_PLATFORM_MAC}/dialogs.mm
    ${MOTE_PLATFORM_MAC}/pdf_export.mm
    ${MOTE_PLATFORM_MAC}/html_export.mm
    ${MOTE_PLATFORM_MAC}/updater.mm
    ${MOTE_PLATFORM_MAC}/web_host_view.mm
    ${MOTE_WEB_FILES}
    ${MOTE_FONT_FILES}
    ${MOTE_SAMPLE_FILES}
    ${MOTE_ICON_FILES})

  target_compile_options(Mote PRIVATE
    "$<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>"
    "$<$<COMPILE_LANGUAGE:CXX>:-Wall>"
    "$<$<COMPILE_LANGUAGE:OBJCXX>:-Wall>")

  # macOS 也注入 MOTE_BUILD / MOTE_BUILD_STR / MOTE_BUILD_HASH（和 Windows 完全对齐）
  # updater.mm 里读 MOTE_BUILD_STR 做同版本 build 比较；
  # 缺失时（开发态直接 cmake）默认 "0"，不阻断编译。
  # MOTE_STRICT_BUILD=ON（发布构建）时强制 MOTE_BUILD != 0，和 shell 层硬门禁双保险。
  if(NOT MOTE_BUILD)
    set(MOTE_BUILD "0")
  endif()
  if(NOT MOTE_BUILD_HASH)
    set(MOTE_BUILD_HASH "")
  endif()
  if(MOTE_BUILD_HASH)
    set(MOTE_BUILD_STAMP "${MOTE_BUILD}-${MOTE_BUILD_HASH}")
  else()
    set(MOTE_BUILD_STAMP "${MOTE_BUILD}")
  endif()
  if(MOTE_STRICT_BUILD AND MOTE_BUILD STREQUAL "0")
    message(FATAL_ERROR "发布构建（MOTE_STRICT_BUILD=ON）必须显式指定 -DMOTE_BUILD=<纯数字构建号>")
  endif()
  target_compile_definitions(Mote PRIVATE
    MOTE_VERSION="${MOTE_VERSION}"
    MOTE_BUILD=${MOTE_BUILD}
    MOTE_BUILD_STR="${MOTE_BUILD_STAMP}")

  target_link_libraries(Mote PRIVATE
    mote_core
    "-framework Cocoa"
    "-framework WebKit"
    "-framework UniformTypeIdentifiers")

  if(MOTE_SPARKLE_ENABLED)
    target_link_libraries(Mote PRIVATE
      "-F${MOTE_REPO_ROOT}/resources"
      "-framework Sparkle")
    # Sparkle 的 install name 是 @rpath/Sparkle.framework/...，必须给出 rpath，
    # 否则运行时 dyld 报 "no LC_RPATH's found" 直接起不来
    target_link_options(Mote PRIVATE
      "-Wl,-rpath,@executable_path/../Frameworks")
    # 让 Xcode/Ninja 找到 Sparkle.framework 的 Headers
    target_include_directories(Mote PRIVATE
      "${MOTE_SPARKLE_FRAMEWORK}/Headers")
  endif()

  set_target_properties(Mote PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "Mote"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.mote.Mote"
    MACOSX_BUNDLE_BUNDLE_VERSION "${MOTE_BUILD}"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "${MOTE_VERSION}"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_BINARY_DIR}/Info.plist")

  if(MOTE_SPARKLE_ENABLED)
    # 构建后把 Sparkle.framework 拷进 .app/Contents/Frameworks/
    # 必须用 ditto 解开 symlink（codesign --deep 遇到 framework 根目录的 symlink
    # 指向 .app bundle 时会报 "bundle format is ambiguous"）
    add_custom_command(TARGET Mote POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory
        "$<TARGET_BUNDLE_CONTENT_DIR:Mote>/Frameworks"
      COMMAND ditto "${MOTE_SPARKLE_FRAMEWORK}"
        "$<TARGET_BUNDLE_CONTENT_DIR:Mote>/Frameworks/Sparkle.framework"
      COMMENT "Copy Sparkle.framework into .app bundle (symlinks resolved)")
  endif()
endif()
