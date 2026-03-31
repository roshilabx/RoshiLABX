@echo off
title RoshiLABX
color 0A
echo.
echo   ==========================================
echo    RoshiLABX - Personal SSH Manager
echo   ==========================================
echo.

REM ── Check Node.js ──
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo [ERROR] Node.js is NOT installed.
    echo.
    echo   Download from: https://nodejs.org  ^(v18+ required^)
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version 2^>^&1') do set NODEVER=%%v
echo [OK] Node.js %NODEVER%
echo.

REM ── Install ALL deps (no --omit=dev, electron is now in dependencies) ──
if not exist "node_modules\electron" (
    echo [*] Installing dependencies...
    echo     First run downloads Electron ~150MB. Please wait.
    echo.
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        color 0C
        echo.
        echo [ERROR] npm install failed.
        echo   - Check your internet connection
        echo   - Try: Right-click setup.bat and "Run as Administrator"
        echo.
        pause
        exit /b 1
    )
    echo.
    echo [OK] All dependencies installed!
    echo.
) else (
    echo [OK] Dependencies already installed.
    echo.
)

REM ── Find electron ──
set EEXE=

REM Windows path for electron
if exist "node_modules\electron\dist\electron.exe" (
    set EEXE=node_modules\electron\dist\electron.exe
    goto :found
)

REM Fallback: use npx electron
where npx >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    set EEXE=npx electron
    goto :found
)

color 0C
echo [ERROR] Could not find electron.exe
echo.
echo   Try this fix:
echo   1. Delete the node_modules folder
echo   2. Run setup.bat again
echo.
pause
exit /b 1

:found
echo [OK] Electron ready.
echo.
echo   Launching RoshiLABX...
echo   This window shows logs. Close it to quit.
echo.
echo ==========================================
echo.

REM ── Launch directly so window stays open ──
if "%EEXE%"=="npx electron" (
    npx electron src\main.js
) else (
    "%EEXE%" src\main.js
)

echo.
if %ERRORLEVEL% NEQ 0 (
    color 0C
    echo [ERROR] App exited with error code %ERRORLEVEL%
    echo.
    echo   Check the output above for details.
    echo   Common fixes:
    echo   1. Delete node_modules and run setup.bat again
    echo   2. Make sure all files from the ZIP were extracted
    echo   3. Antivirus may be blocking electron.exe - add an exception
) else (
    echo [OK] RoshiLABX closed normally.
)
echo.
pause
