@echo off
rem Mind -- double-click launcher. The real work is in mind.ps1.
chcp 65001 >nul
setlocal
set "SCRIPT=%~dp0mind.ps1"
if not exist "%SCRIPT%" (
    echo mind.ps1 is missing next to this file.
    pause
    exit /b 1
)
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
