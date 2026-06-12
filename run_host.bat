@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "HOST_SCRIPT=%SCRIPT_DIR%native_host.py"

where py >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  py -3 "%HOST_SCRIPT%"
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  python "%HOST_SCRIPT%"
  exit /b %ERRORLEVEL%
)

if exist "C:\Python312\python.exe" (
  "C:\Python312\python.exe" "%HOST_SCRIPT%"
  exit /b %ERRORLEVEL%
)

echo Python 3 was not found. Install Python or add it to PATH. 1>&2
exit /b 1
