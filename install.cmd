@echo off
setlocal
rem dsh-lan-bridge installer: sync source, register as a profile file: dependency,
rem run pnpm install, and append the lan-bridge row to the profile patch (idempotent).
set "SRC=%~dp0"
for %%I in ("%SRC%.") do set "SRC=%%~fI\"
set "DSH_HOME=%USERPROFILE%\.dsh"
set "PROFILE=%DSH_HOME%\profiles\web"
set "DEPLOY=%DSH_HOME%\lan-bridge"
set "PKGJSON=%PROFILE%\package.json"
set "PATCH=%PROFILE%\cordis.patch.yml"

if not exist "%PROFILE%\node_modules" mkdir "%PROFILE%\node_modules"

rem 1) sync source into the dsh home (xcopy excludes the deploy copy itself)
if not exist "%DEPLOY%" mkdir "%DEPLOY%"
xcopy "%SRC%lib" "%DEPLOY%\lib" /E /I /Y /Q >nul
xcopy "%SRC%bin" "%DEPLOY%\bin" /E /I /Y /Q >nul
copy /Y "%SRC%package.json" "%DEPLOY%\package.json" >nul
copy /Y "%SRC%cordis.patch.yml" "%DEPLOY%\cordis.patch.yml" >nul
copy /Y "%SRC%README.md" "%DEPLOY%\README.md" >nul
echo [lan-bridge] synced to %DEPLOY%

rem 2) register the file: dependency (idempotent)
findstr /C:"dsh-lan-bridge" "%PKGJSON%" >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "$p='%PKGJSON%'; $j=Get-Content $p -Raw | ConvertFrom-Json; $j.dependencies.'dsh-lan-bridge'='file:../../lan-bridge'; $j | ConvertTo-Json -Depth 10 | Set-Content $p -Encoding utf8"
  echo [lan-bridge] registered file dependency in package.json
) else (
  echo [lan-bridge] dependency already registered
)

rem 3) pnpm install if available (creates/manages node_modules\dsh-lan-bridge link)
where pnpm >nul 2>&1
if errorlevel 1 (
  echo [lan-bridge] pnpm not found - creating junction manually
  if exist "%PROFILE%\node_modules\dsh-lan-bridge" (
    echo [lan-bridge] node_modules\dsh-lan-bridge already present
  ) else (
    mklink /J "%PROFILE%\node_modules\dsh-lan-bridge" "%DEPLOY%"
  )
) else (
  pushd "%PROFILE%"
  set CI=true
  call pnpm install --no-frozen-lockfile
  popd
)

rem 4) append the lan-bridge row to the profile patch (idempotent)
findstr /C:"- id: lan-bridge" "%PATCH%" >nul 2>&1
if errorlevel 1 (
  echo. >> "%PATCH%"
  echo # dsh-lan-bridge: LAN face with Host/Origin rewritten to loopback (full /api, incl. settings). >> "%PATCH%"
  echo # SECURITY: NOT authentication - trusted LAN only, never port-forward. >> "%PATCH%"
  echo - insert: >> "%PATCH%"
  echo     - id: lan-bridge >> "%PATCH%"
  echo       name: dsh-lan-bridge >> "%PATCH%"
  echo       config: >> "%PATCH%"
  echo         listenHost: '0.0.0.0' >> "%PATCH%"
  echo         listenPort: 2882 >> "%PATCH%"
  echo         targetHost: '127.0.0.1' >> "%PATCH%"
  echo [lan-bridge] appended row to %PATCH%
) else (
  echo [lan-bridge] patch row already present
)

echo.
echo [lan-bridge] done. Restart DeepSeek Harness (or wait for patch hot-reload), then open:
echo   http://<LAN-IP>:2882   (e.g. http://192.168.1.23:2882)
echo.
echo Firewall (run as ADMIN PowerShell) if LAN access is blocked:
echo   netsh advfirewall firewall add rule name="DeepSeek Harness Web LAN Bridge" dir=in action=allow protocol=TCP localport=2882 profile=private,domain
endlocal
