@echo off
setlocal
if not exist "%~dp0server\glance-api.js" goto missing
start "" wscript.exe "%~dp0server\glance-api.vbs"
echo glance-api: started hidden on http://127.0.0.1:47821/v1
exit /b 0
:missing
echo server\glance-api.js not found
exit /b 1
