@echo off
rem Per-user logon start for the local API. No elevation, no console window.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\install-autostart.ps1"
pause
