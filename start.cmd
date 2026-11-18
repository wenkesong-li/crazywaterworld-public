@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
    echo First run: downloading Node.js runtime with progress bar...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\bootstrap-runtime.ps1" -Destination "%~dp0runtime"
    if errorlevel 1 (
        echo Failed to download Node.js runtime. Check the network and retry.
        pause
        exit /b 1
    )
)
set "PATH=%~dp0runtime;%PATH%"
if not exist "node_modules" (
    echo First run: installing dependencies, please wait 1-3 minutes...
    call "%~dp0runtime\npm.cmd" ci
    if errorlevel 1 (
        echo Dependency installation failed. Check the network and retry.
        pause
        exit /b 1
    )
)
echo Starting console...
call "%~dp0runtime\npm.cmd" start %*
set "code=%ERRORLEVEL%"
if not "%code%"=="0" pause
exit /b %code%
