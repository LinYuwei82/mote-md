@echo off
chcp 936 >nul
rem 本机自检（Windows）：仓库状态 -> 独立目录构建 -> 人工启动验证
rem 用法：在仓库根目录执行 tools\preflight.bat
rem 退出码：0 通过，1 构建失败
rem
rem 前提（缺一不可）：
rem   1) Qt 6，且对应套件的 qmake 在 PATH：
rem        MSVC 套件如 C:\Qt\6.6.3\msvc2019_64\bin
rem        MinGW 套件如 C:\Qt\6.6.3\mingw_64\bin（还要把 Qt Tools 的 mingw 的 bin 加进 PATH）
rem   2) 构建工具：MSVC 需在「x64 Native Tools 命令提示符」里运行本脚本（nmake 可用）；
rem      MinGW 需 mingw32-make 可用
rem   3) WebView2 SDK（NuGet 包 Microsoft.Web.WebView2 1.0.2903.40）放在仓库外：
rem        解包到 C:\dev\webview2sdk\pkg，或设 WEBVIEW2_SDK 指向该解包目录，
rem        目录里应有 build\native\include\WebView2.h 与 build\native\x64\WebView2Loader.dll；
rem        放在 NuGet 全局缓存（%USERPROFILE%\.nuget\packages\microsoft.web.webview2\<版本>）也会被自动发现
rem        下载页：https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.2903.40
rem
rem 验证记录（2026-11-14，Windows 11 + 本机 Qt 6.6.3）：
rem   - Qt 6.6.3 msvc2019_64 + Visual Studio 2022：qmake + nmake 干净构建通过，
rem     WebView2Loader.dll 自动复制到产物目录，启动后 welcome.md 正常渲染
rem   - Qt 6.6.3 mingw_64 + Qt Tools mingw1120_64：qmake + mingw32-make 干净构建通过，
rem     WebView2Loader.dll 自动复制，启动后 welcome.md 正常渲染
setlocal

cd /d "%~dp0.."
if errorlevel 1 goto no_repo
set "ROOT=%CD%"

echo == 1. 仓库状态 ==
set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%b"
if not defined BRANCH goto no_git
echo 分支：%BRANCH%
set "DIRTY=0"
for /f %%c in ('git status --porcelain ^| find /c /v ""') do set "DIRTY=%%c"
if not "%DIRTY%"=="0" (
    echo [WARN] 有 %DIRTY% 个未提交/未跟踪改动，换机器前必须处理：
    git status --short
)

echo == 2. 寻找 Qt ==
where qmake >nul 2>nul
if errorlevel 1 goto no_qmake
set "MAKE=nmake"
where nmake >nul 2>nul
if not errorlevel 1 goto make_found
set "MAKE=mingw32-make"
where mingw32-make >nul 2>nul
if errorlevel 1 goto no_make
:make_found
echo 使用 %MAKE%

echo == 3. 独立目录构建 ==
set "BUILD_DIR=%TEMP%\mote-preflight"
if exist "%BUILD_DIR%" rmdir /s /q "%BUILD_DIR%"
mkdir "%BUILD_DIR%" 2>nul
if not exist "%BUILD_DIR%" goto no_build_dir
pushd "%BUILD_DIR%"
qmake "%ROOT%\Mote.pro" > build.log 2>&1
if errorlevel 1 goto build_failed
%MAKE% >> build.log 2>&1
if errorlevel 1 goto build_failed
popd

set "EXE=%BUILD_DIR%\release\Mote.exe"
if not exist "%EXE%" set "EXE=%BUILD_DIR%\Mote.exe"
if not exist "%EXE%" goto missing_exe

echo [OK] 构建通过：%EXE%
echo == 4. 手动启动验证 ==
echo 请双击运行上面的 Mote.exe，确认：窗口能打开、欢迎文档正常渲染、
echo 正文可编辑、缩放与目录可用。确认后再合入 main。
echo 构建日志：%BUILD_DIR%\build.log
exit /b 0

:build_failed
echo [FAIL] 构建失败，日志中的 error 行：
findstr /n /i "error" "%BUILD_DIR%\build.log"
echo 完整日志：%BUILD_DIR%\build.log
popd
exit /b 1

:missing_exe
echo [FAIL] 构建返回 0，但在 release\ 与根目录都没有找到 Mote.exe
echo 完整日志：%BUILD_DIR%\build.log
exit /b 1

:no_repo
echo [FAIL] 无法进入仓库根目录（%~dp0..）
exit /b 1

:no_git
echo [FAIL] 读取 git 分支失败：确认已安装 Git 且当前目录是仓库
exit /b 1

:no_qmake
echo [FAIL] 找不到 qmake：把 Qt 的 bin 目录加进 PATH 后重试
echo        例：set "PATH=C:\Qt\6.6.3\msvc2019_64\bin;%PATH%"（MinGW 套件换成 mingw_64\bin）
exit /b 1

:no_make
echo [FAIL] 找不到 nmake 或 mingw32-make：确认在 Qt 命令行环境中运行
echo        MSVC 用「x64 Native Tools 命令提示符」；MinGW 需把 Qt Tools 的 mingw 的 bin 加进 PATH
exit /b 1

:no_build_dir
echo [FAIL] 无法创建构建目录：%BUILD_DIR%
exit /b 1
