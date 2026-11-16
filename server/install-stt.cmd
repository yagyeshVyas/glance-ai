@echo off
rem Installs local transcription: faster-whisper plus the base.en model.
rem Run once. The model (~145 MB) downloads on first use and is cached.
setlocal
set "PY="
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  where py >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo Python 3 was not found on PATH. Install it, then run this again.
  exit /b 1
)
echo Using: %PY%
%PY% -m pip install --upgrade --disable-pip-version-check faster-whisper
if errorlevel 1 (
  echo pip install failed.
  exit /b 1
)
echo Downloading the base.en model (first run only)...
%PY% -c "from faster_whisper import WhisperModel; WhisperModel('base.en', device='cpu', compute_type='int8'); print('model ready')"
if errorlevel 1 (
  echo Model download failed. Check the network, then run this again.
  exit /b 1
)
echo.
echo Done. server\glance-api.js now answers /v1/audio/transcriptions locally.
endlocal
