@echo off
setlocal
echo Installing AI Prompt Queue Native Host...
echo This host supports transcription monitoring and read-only local memory bridge requests.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_native_host.ps1" %*
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo Native host installation failed.
  echo Pass your extension ID if auto-detection did not find it:
  echo   install_native_host.bat -EdgeExtensionId YOUR_EDGE_EXTENSION_ID
  echo   install_native_host.bat -ChromeExtensionId YOUR_CHROME_EXTENSION_ID
  pause
  exit /b %EXIT_CODE%
)

echo Reload the extension after installation.
pause
