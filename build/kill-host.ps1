# Stop only OUR process (running from the System32/SysWOW64 mirror), never a
# real svchost: ours is the only one whose path contains "assistant".
# Used by the installer before mirroring, because a running image locks its
# exe/DLLs and the copy would otherwise leave stale files behind.
#
# WMI instead of Get-Process: NSIS is a 32-bit process, so it spawns 32-bit
# PowerShell, and a 32-bit process cannot read MainModule/Path of a 64-bit
# process. The old `Get-Process | Where-Object Path -like` filter therefore
# matched nothing, the running instance survived the install and kept the
# single-instance lock, and the post-install launch exited immediately with
# singleInstance=false — which looks exactly like "the installer never opened it".
$ErrorActionPreference = 'SilentlyContinue'

$pids = @(
  Get-CimInstance Win32_Process -Filter "Name='assistant.exe'" |
    Where-Object { $_.ExecutablePath -like '*assistant*' } |
    Select-Object -ExpandProperty ProcessId
)

foreach ($procId in $pids) {
  try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
}

# let a killed instance release its single-instance lock before the next start
for ($i = 0; $i -lt 20; $i++) {
  if (-not (Get-Process -Name 'assistant' -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}

Start-Sleep -Milliseconds 300
exit 0
