@echo off
echo Installing AI Prompt Queue Native Host...

REM Get the directory where this script is located
set SCRIPT_DIR=%~dp0
set SCRIPT_DIR=%SCRIPT_DIR:~0,-1%

REM Create the registry file
echo Windows Registry Editor Version 5.00 > temp.reg
echo. >> temp.reg
echo [HKEY_CURRENT_USER\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.aipromptqueue.transcription] >> temp.reg
echo "%SCRIPT_DIR%\\native_host.json" >> temp.reg

REM Create the native host manifest file
echo { > "%SCRIPT_DIR%\native_host.json"
echo   "name": "com.aipromptqueue.transcription", >> "%SCRIPT_DIR%\native_host.json"
echo   "description": "AI Prompt Queue Transcription Monitor", >> "%SCRIPT_DIR%\native_host.json"
echo   "path": "%SCRIPT_DIR%\\native_host.py", >> "%SCRIPT_DIR%\native_host.json"
echo   "type": "stdio", >> "%SCRIPT_DIR%\native_host.json"
echo   "allowed_origins": [ >> "%SCRIPT_DIR%\native_host.json"
echo     "chrome-extension://YOUR_EXTENSION_ID/" >> "%SCRIPT_DIR%\native_host.json"
echo   ] >> "%SCRIPT_DIR%\native_host.json"
echo } >> "%SCRIPT_DIR%\native_host.json"

REM Import the registry file
regedit /s temp.reg
del temp.reg

echo.
echo Native host installed successfully!
echo.
echo IMPORTANT: You need to update the native_host.json file with your actual extension ID.
echo Find your extension ID in chrome://extensions and replace "YOUR_EXTENSION_ID" in:
echo %SCRIPT_DIR%\native_host.json
echo.
pause
