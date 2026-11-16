# Registers (or removes) the local API as a per-user logon task.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File server\install-autostart.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File server\install-autostart.ps1 -Remove
#
# A Run value, not a scheduled task: it starts with the session, runs hidden
# because wscript has no console, and needs no elevation. HKCU, so it is this
# user only and shows up in Task Manager as node.exe, nothing else.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'GlanceAPI'
$vbs = Join-Path $PSScriptRoot 'glance-api.vbs'

if ($Remove) {
  if (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $key -Name $name
    Write-Output "removed $name from $key"
  } else {
    Write-Output "$name is not registered"
  }
  exit 0
}

if (-not (Test-Path $vbs)) { throw "missing launcher: $vbs" }
New-ItemProperty -Path $key -Name $name -Value ('wscript.exe "' + $vbs + '"') -PropertyType String -Force | Out-Null
Write-Output "registered: wscript.exe `"$vbs`""
Write-Output 'It starts at the next logon. To start it now: start-api.cmd'
