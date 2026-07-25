@echo off
setlocal

rem Override RENDER_EXE only for testing or a custom Render CLI location.
if not defined RENDER_EXE (
  where render >nul 2>&1
  if errorlevel 1 (
    set "RENDER_EXE=%LOCALAPPDATA%\Programs\RenderCLI\render.exe"
  ) else (
    set "RENDER_EXE=render"
  )
)

if not exist "%RENDER_EXE%" if not "%RENDER_EXE%"=="render" (
  echo Render CLI was not found. Install it, then try again.
  if not defined NO_PAUSE pause
  exit /b 1
)

echo.
echo Deploying the latest commit to JLTG-Map-Companion...
call "%RENDER_EXE%" deploys create srv-d97l5ku7r5hc73cvk9jg --confirm --wait
if errorlevel 1 goto :failed
call :show_deploy_info "JLTG-Map-Companion" "srv-d97l5ku7r5hc73cvk9jg"
if errorlevel 1 goto :failed

echo.
echo Deploying the latest commit to jltg-backend...
call "%RENDER_EXE%" deploys create srv-d988bu6rnols73esk36g --confirm --wait
if errorlevel 1 goto :failed
call :show_deploy_info "jltg-backend" "srv-d988bu6rnols73esk36g"
if errorlevel 1 goto :failed

echo.
echo Both JLTG companion deployments completed successfully.
if not defined NO_PAUSE pause
exit /b 0

:show_deploy_info
echo.
echo Latest deployment details for %~1:
powershell -NoProfile -Command "$deploys = (& $env:RENDER_EXE deploys list '%~2' --output json | ConvertFrom-Json); $deploy = $deploys[0]; if (-not $deploy) { throw 'No deployment record was returned.' }; function Format-Ist([string]$time) { ([DateTimeOffset]::Parse($time)).ToOffset([TimeSpan]::FromMinutes(330)).ToString('yyyy-MM-dd HH:mm:ss') + ' IST' } function Format-Utc([string]$time) { ([DateTimeOffset]::Parse($time)).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss') + ' UTC' }; $shortId = $deploy.commit.id.Substring(0, [Math]::Min(7, $deploy.commit.id.Length)); Write-Output ('  Commit ID: ' + $shortId); Write-Output ('  Commit time: ' + (Format-Utc $deploy.commit.createdAt) + ' | ' + (Format-Ist $deploy.commit.createdAt))"
exit /b %errorlevel%

:failed
echo.
echo A deployment or status lookup failed. Review the output above and try again.
if not defined NO_PAUSE pause
exit /b 1
