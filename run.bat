@echo off
title RoshiLABX

if not exist "node_modules\electron" (
    echo [!] Dependencies not installed. Run setup.bat first.
    pause
    exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
    "node_modules\electron\dist\electron.exe" src\main.js
) else (
    npx electron src\main.js
)

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] App crashed - error code %ERRORLEVEL%
    pause
)
