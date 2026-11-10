@echo off
chcp 936 >nul
setlocal EnableDelayedExpansion

REM ============================================================
REM  Windows 打包脚本（在 Windows 机器上执行）
REM
REM  前置条件：
REM    1) 安装 Qt 6（MSVC 2022 x64 或 MinGW 64-bit 套件）
REM    2) 若用 MSVC：安装 Visual Studio 生成工具，并从「x64 Native Tools 命令提示符」
REM       运行本脚本（保证 nmake / cl.exe 在 PATH 中）
REM    3) 若用 MinGW：%QTDIR%\bin 与 MinGW 的 bin 目录需在 PATH 中
REM    4) WebView2 SDK（NuGet 包 Microsoft.Web.WebView2）解压在仓库外，
REM       默认 C:\dev\webview2sdk\pkg，可用 WEBVIEW2_SDK 覆盖
REM
REM  用法（在项目根目录的命令行中）：
REM    set QTDIR=C:\Qt\6.8.0\msvc2022_64
REM    packaging\package_windows.bat
REM
REM    使用 MinGW 套件时：
REM    set QTDIR=C:\Qt\6.8.0\mingw_64
REM    set USE_MINGW=1
REM    packaging\package_windows.bat
REM
REM  产物：dist\Mote-Windows\ 与 dist\Mote-Windows.zip
REM ============================================================

set "ROOT=%~dp0.."
set "BUILD=%ROOT%\build"
set "DIST=%ROOT%\dist"
set "OUTNAME=Mote-Windows"
set "OUT=%DIST%\%OUTNAME%"
if "%WEBVIEW2_SDK%"=="" set "WEBVIEW2_SDK=C:\dev\webview2sdk\pkg"

if "%QTDIR%"=="" (
    echo [错误] 请先设置 QTDIR 指向 Qt6 安装目录，例如：
    echo        set QTDIR=C:\Qt\6.8.0\msvc2022_64
    exit /b 1
)
if not exist "%QTDIR%\bin\qmake.exe" (
    echo [错误] 找不到 %QTDIR%\bin\qmake.exe
    exit /b 1
)
if not exist "%QTDIR%\bin\windeployqt.exe" (
    echo [错误] 找不到 %QTDIR%\bin\windeployqt.exe
    exit /b 1
)
if not exist "%WEBVIEW2_SDK%\build\native\x64\WebView2Loader.dll" (
    echo [错误] 找不到 %WEBVIEW2_SDK%\build\native\x64\WebView2Loader.dll
    echo        请设置 WEBVIEW2_SDK 指向 NuGet 包 Microsoft.Web.WebView2 的解压目录
    exit /b 1
)

echo [1/6] 清理旧的构建与产物目录
if exist "%BUILD%" rmdir /s /q "%BUILD%"
if exist "%DIST%" rmdir /s /q "%DIST%"
mkdir "%BUILD%"
mkdir "%DIST%"

echo [2/6] qmake 生成工程
pushd "%BUILD%"
"%QTDIR%\bin\qmake.exe" "%ROOT%\Mote.pro"
if errorlevel 1 goto :fail

echo [3/6] 编译 Release
if defined USE_MINGW (
    mingw32-make -j%NUMBER_OF_PROCESSORS%
) else (
    nmake /NOLOGO
)
if errorlevel 1 goto :fail

set "EXE=%BUILD%\Mote.exe"
if not exist "%EXE%" set "EXE=%BUILD%\release\Mote.exe"
if not exist "%EXE%" (
    echo [错误] 未找到编译产物 Mote.exe
    goto :fail
)
popd

echo [4/6] 复制可执行文件并部署 Qt 依赖（windeployqt）
mkdir "%OUT%"
copy /y "%EXE%" "%OUT%\" >nul
if errorlevel 1 goto :fail

REM --compiler-runtime：MinGW 套件一并复制 libgcc/libstdc++/libwinpthread，
REM 解压即用，不依赖目标机器安装 Qt 或编译器运行库。
"%QTDIR%\bin\windeployqt.exe" --release --compiler-runtime --no-translations --no-system-d3d-compiler --no-opengl-sw "%OUT%\Mote.exe"
if errorlevel 1 goto :fail

REM WebView2 原生加载器：必须与 exe 同级；浏览器内核由系统 Evergreen Runtime 提供
copy /y "%WEBVIEW2_SDK%\build\native\x64\WebView2Loader.dll" "%OUT%\" >nul
if errorlevel 1 goto :fail

echo [5/6] 清理无用文件，控制包体
if exist "%OUT%\opengl32sw.dll" del /q "%OUT%\opengl32sw.dll"
if exist "%OUT%\d3dcompiler_47.dll" del /q "%OUT%\d3dcompiler_47.dll"
if exist "%OUT%\Qt6Pdf.dll" del /q "%OUT%\Qt6Pdf.dll"
if exist "%OUT%\imageformats\qpdf.dll" del /q "%OUT%\imageformats\qpdf.dll"
if exist "%OUT%\Qt6Qml.dll" del /q "%OUT%\Qt6Qml.dll"
if exist "%OUT%\Qt6Quick.dll" del /q "%OUT%\Qt6Quick.dll"
if exist "%OUT%\translations" rmdir /s /q "%OUT%\translations"
if exist "%OUT%\qml" rmdir /s /q "%OUT%\qml"
del /q "%OUT%\*.pdb" 2>nul
del /q "%OUT%\*.exp" 2>nul
del /q "%OUT%\*.lib" 2>nul

REM 示例文档（与 macOS 包保持一致）
mkdir "%OUT%\samples"
copy /y "%ROOT%\resources\samples\welcome.md" "%OUT%\samples\" >nul
copy /y "%ROOT%\resources\samples\sample-diagram.png" "%OUT%\samples\" >nul

REM 内置字体是嵌入二进制 OFL 授权文件（SIL Open Font License 要求随附）
mkdir "%OUT%\licenses"
copy /y "%ROOT%\resources\fonts\OFL.txt" "%OUT%\licenses\JetBrainsMono-OFL.txt" >nul

echo [6/6] 压缩为 zip
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Compress-Archive -Path '%OUT%' -DestinationPath '%DIST%\%OUTNAME%.zip' -Force"
if errorlevel 1 goto :fail

echo.
echo 打包完成：
echo   %DIST%\%OUTNAME%.zip
echo.
echo 提示：
echo   - 正文渲染依赖系统的 Microsoft Edge WebView2 Runtime（Win10/11 一般已预装）；
echo     目标机器缺失时，Mote 会提示下载：https://go.microsoft.com/fwlink/p/?LinkId=2124703
echo   - 发布前建议在未安装 Qt 的 Windows 机器上解压 zip，双击 exe 验证。
exit /b 0

:fail
echo.
echo [失败] 打包中断，请查看上面的错误信息。
exit /b 1
