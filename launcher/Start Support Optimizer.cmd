@echo off
REM ---------------------------------------------------------------
REM  Support Optimizer - double-click launcher (Windows)
REM
REM  Starts a small local web server in this folder and opens the app
REM  in your default browser. Nothing is installed; closing this
REM  window stops the server again.
REM ---------------------------------------------------------------

setlocal
cd /d "%~dp0"

if not exist "index.html" (
  echo.
  echo   ERROR: index.html was not found next to this launcher.
  echo   Put this file in the same folder as index.html and assets\.
  echo.
  pause
  exit /b 1
)

set PORT=8731
set URL=http://localhost:%PORT%

echo.
echo   Starting Support Optimizer on %URL%
echo   Keep this window open while you use the app.
echo   Close it (or press Ctrl+C) to stop.
echo.

REM NOTE: we deliberately do NOT use "where python" to pick a runtime.
REM On Windows, "python" often resolves to the Microsoft Store app-execution
REM alias, which "where" finds but which is not a working Python at all - it
REM just prints "Python was not found" and exits with 9009. So each candidate
REM is tested by actually RUNNING it and checking the exit code.

python -c "pass" >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  python -m http.server %PORT%
  goto :eof
)

py -3 -c "pass" >nul 2>&1
if not errorlevel 1 (
  start "" "%URL%"
  py -3 -m http.server %PORT%
  goto :eof
)

node -e "0" >nul 2>&1
if not errorlevel 1 (
  echo   Using Node - the first run downloads a small helper, please wait...
  start "" "%URL%"
  call npx --yes serve . -l %PORT%
  goto :eof
)

echo.
echo   Neither a working Python nor Node.js was found on this computer.
echo   Install Node.js from https://nodejs.org (the LTS button),
echo   then double-click this file again.
echo.
pause
