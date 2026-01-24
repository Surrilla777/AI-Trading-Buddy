@echo off
title Spam Scanner
color 0A
echo.
echo  ========================================
echo     SPAM SCANNER - Local Version
echo  ========================================
echo.
echo  Starting server...
echo.

cd /d "%~dp0"

:: Check if node_modules exists
if not exist "node_modules" (
    echo  Installing dependencies...
    call npm install --silent
    echo.
)

:: Start browser after 3 seconds
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3001"

:: Start the server
echo  Server starting at http://localhost:3001
echo.
echo  Press Ctrl+C to stop the server
echo  ========================================
echo.
node server.js

pause
