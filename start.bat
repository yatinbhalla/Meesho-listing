@echo off
REM Launches the Meesho lister (API server + Vite client).
REM Double-click this file, or run it from any directory / any drive.
REM %~dp0 is this script's own folder, so the project can be moved anywhere.

cd /d "%~dp0"

if not exist "node_modules\" (
  echo node_modules not found - running npm install first...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Fix the errors above and try again.
    pause
    exit /b 1
  )
)

npm start

echo.
echo Server stopped.
pause
