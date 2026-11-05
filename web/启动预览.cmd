@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist "web\dist\index.html" (
  echo Please run npm ci and npm run build first.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:8765"
node web\tools\serve.mjs
pause
