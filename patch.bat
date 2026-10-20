@echo off
REM Cambridge One -> PDF patcher (double-click me)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
node "%~dp0patch.js" %*
pause
