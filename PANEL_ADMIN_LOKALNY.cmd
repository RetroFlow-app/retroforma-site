@echo off
setlocal
cd /d "%~dp0"

if "%RETROFORMA_ADMIN_CODE%"=="" (
  set /p RETROFORMA_ADMIN_CODE=Wpisz lokalny kod admina i zapamietaj go: 
)

if "%RETROFORMA_ADMIN_CODE%"=="" (
  echo Kod admina jest wymagany.
  pause
  exit /b 1
)

set "PORT=5520"
set "RETROFORMA_DATA_DIR=%~dp0data"
set "LOCAL_URL=http://127.0.0.1:%PORT%/admin/"

echo.
echo Panel lokalny RetroForma
echo Adres: %LOCAL_URL%
echo Dane zapisuja sie w: %~dp0data\projects.json
echo Gdy skonczysz, wroc do Codexa i napisz: wrzuc na strone.
echo.

start "" "%LOCAL_URL%"

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
) else (
  node server.js
)

pause
