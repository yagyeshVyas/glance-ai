@echo off
rem Removes the logon start. Does not stop a running server — use stop-api.cmd.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\install-autostart.ps1" -Remove
pause
