@echo off
REM ASCII only. Builds the job-object launcher (Windows helper for issue #144).
setlocal
set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=x64"
set "VC_ARCH="
if /I "%TARGET%"=="x64" set "VC_ARCH=amd64"
if /I "%TARGET%"=="arm64" set "VC_ARCH=amd64_arm64"
set "VC_COMPONENT=Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  set "VC_COMPONENT=Microsoft.VisualStudio.Component.VC.Tools.ARM64"
  if /I "%TARGET%"=="arm64" set "VC_ARCH=arm64"
  if /I "%TARGET%"=="x64" set "VC_ARCH=arm64_x64"
)
if not defined VC_ARCH (
  echo Unsupported target architecture: %TARGET% 1>&2
  exit /b 1
)
set "OUTPUT_DIR=%~2"
if not defined OUTPUT_DIR set "OUTPUT_DIR=%~dp0win32-%TARGET%"
for %%I in ("%OUTPUT_DIR%") do set "OUTPUT_DIR=%%~fI"
if /I "%VSCMD_ARG_TGT_ARCH%"=="%TARGET%" (
  where cl.exe >nul 2>&1
  if not errorlevel 1 goto compile
)
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo MSVC C++ build tools are required; vswhere.exe was not found. 1>&2
  exit /b 1
)
set "VSROOT="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires %VC_COMPONENT% -property installationPath`) do set "VSROOT=%%I"
if not defined VSROOT (
  echo MSVC C++ compiler context was not found. 1>&2
  exit /b 1
)
call "%VSROOT%\VC\Auxiliary\Build\vcvarsall.bat" %VC_ARCH%
if errorlevel 1 exit /b 1
:compile
where cl.exe >nul 2>&1
if errorlevel 1 exit /b 1
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"
if errorlevel 1 exit /b 1
cl /nologo /O2 /W3 /Fe:"%OUTPUT_DIR%\job-launch.exe" /Fo:"%OUTPUT_DIR%\job-launch.obj" "%~dp0job-launch.c"
if errorlevel 1 exit /b 1
exit /b 0
