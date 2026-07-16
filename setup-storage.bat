@echo off
REM ============================================================
REM  Keep all WhatsApp session storage INSIDE the project folder:
REM     whatsapp-backend\webjs   <- whatsapp-web.js session data
REM     whatsapp-backend\wwp     <- WPPConnect tokens (was "tokens")
REM
REM  C:\wa-sessions is kept as a JUNCTION -> whatsapp-backend\webjs, so the
REM  engine still writes through a SHORT path (avoids the Windows 260-char
REM  MAX_PATH crash that broke the QR), while the real bytes live in the
REM  project and travel with a folder copy.
REM
REM  >>> STOP the backend / NSSM service before running (files get locked). <<<
REM  Safe to re-run. Also run this once on a NEW machine after copying the code.
REM ============================================================
setlocal EnableExtensions
set "PROJ=%~dp0"
set "WEBJS=%PROJ%webjs"
set "WWP=%PROJ%wwp"

if not exist "%WEBJS%" mkdir "%WEBJS%"

echo.
echo === webjs session data ===
dir "C:\" /AL 2>nul | find /I "wa-sessions" >nul
if %errorlevel%==0 (
  echo C:\wa-sessions is already a junction - leaving it.
) else (
  if exist "C:\wa-sessions\" (
    echo Moving existing sessions from C:\wa-sessions into the project...
    robocopy "C:\wa-sessions" "%WEBJS%" /E /MOVE /NFL /NDL /NJH /NJS /NC /NS >nul
    rmdir /S /Q "C:\wa-sessions" 2>nul
  )
  echo Creating junction  C:\wa-sessions  -^>  "%WEBJS%"
  mklink /J "C:\wa-sessions" "%WEBJS%" >nul
  if errorlevel 1 echo   ^(mklink failed - re-run this window as Administrator^)
)

echo.
echo === WPPConnect tokens ===
if exist "%PROJ%tokens\" (
  if not exist "%WWP%\" (
    echo Renaming tokens -^> wwp ...
    move "%PROJ%tokens" "%WWP%" >nul
  ) else (
    echo Both tokens\ and wwp\ exist - leaving tokens\ untouched. Merge manually if needed.
  )
) else (
  if not exist "%WWP%\" mkdir "%WWP%"
  echo No tokens\ folder - using wwp\.
)

echo.
echo Done. Storage now lives in:
echo    %WEBJS%   ^(reached via the C:\wa-sessions junction^)
echo    %WWP%
echo.
echo You can now restart the backend / NSSM service.
echo.
pause
endlocal
