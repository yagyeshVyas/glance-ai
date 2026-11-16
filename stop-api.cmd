@echo off
setlocal
set "PIDFILE=%~dp0server\run\api.pid"
if not exist "%PIDFILE%" goto nopid
set /p PID=<"%PIDFILE%"
if "%PID%"=="" goto badpid
tasklist /FI "PID eq %PID%" /FI "IMAGENAME eq node.exe" 2>nul | find /I "node.exe" >nul
if errorlevel 1 goto stale
taskkill /PID %PID% /F >nul 2>&1
del "%PIDFILE%" >nul 2>&1
echo glance-api: stopped (pid %PID%)
exit /b 0
:nopid
echo glance-api: no pid file, nothing to stop
exit /b 0
:badpid
del "%PIDFILE%" >nul 2>&1
echo glance-api: empty pid file, removed
exit /b 0
:stale
del "%PIDFILE%" >nul 2>&1
echo glance-api: pid %PID% is not node.exe any more - removed stale pid file
exit /b 0
