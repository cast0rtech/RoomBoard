@echo off
REM ============================================================================
REM RoomBoard Hub — Instalador de servicio de Windows con NSSM y rotación de logs
REM Ejecutar como Administrador.
REM ============================================================================

set SERVICE_NAME=RoomBoardHub
set APP_DIR=%~dp0..
set NODE_EXE=node.exe
set DIST_JS=%APP_DIR%\dist\index.js
set LOG_DIR=%APP_DIR%\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [1/4] Verificando compilacion del Hub...
if not exist "%DIST_JS%" (
  echo Error: %DIST_JS% no existe. Ejecuta 'npm run build' primero.
  exit /b 1
)

echo [2/4] Verificando NSSM...
where nssm >nul 2>nul
if %errorlevel% neq 0 (
  echo Error: nssm.exe no esta en el PATH.
  echo Descarga NSSM desde https://nssm.cc/download y copialo a C:\Windows\System32 o al PATH.
  exit /b 1
)

echo [3/4] Instalando servicio %SERVICE_NAME%...
nssm stop %SERVICE_NAME% >nul 2>nul
nssm remove %SERVICE_NAME% confirm >nul 2>nul

nssm install %SERVICE_NAME% "%NODE_EXE%" "%DIST_JS%"
nssm set %SERVICE_NAME% AppDirectory "%APP_DIR%"
nssm set %SERVICE_NAME% Description "Servicio local RoomBoard Hub para calendarios de Microsoft Graph"
nssm set %SERVICE_NAME% Start SERVICE_AUTO_START

REM Configuracion de reinicio automatico ante fallos
nssm set %SERVICE_NAME% AppRestartDelay 5000

REM Configuracion de salida y rotacion de logs
nssm set %SERVICE_NAME% AppStdout "%LOG_DIR%\hub-service.log"
nssm set %SERVICE_NAME% AppStderr "%LOG_DIR%\hub-service-error.log"
nssm set %SERVICE_NAME% AppRotateFiles 1
nssm set %SERVICE_NAME% AppRotateOnline 1
nssm set %SERVICE_NAME% AppRotateBytes 10485760

echo [4/4] Iniciando servicio...
nssm start %SERVICE_NAME%

echo.
echo ============================================================================
echo Servicio %SERVICE_NAME% instalado e iniciado con exito.
echo Para comprobar estado: nssm status %SERVICE_NAME%
echo Para ver logs: %LOG_DIR%\hub-service.log
echo ============================================================================
