# Stop only OUR process, never a real svchost: ours is the only svchost.exe that
# lives inside a "svchost" subfolder (the Windows ones sit directly in
# System32/SysWOW64). Used by the installer before mirroring, because a running
# image locks its exe/DLLs and the copy would otherwise leave stale files behind.
#
# WMI instead of Get-Process: NSIS is a 32-bit process, so it spawns 32-bit
# PowerShell, and a 32-bit process cannot read MainModule/Path of a 64-bit
# process. The old `Get-Process | Where-Object Path -like` filter therefore
# matched nothing, the running instance survived the install and kept the
# single-instance lock, and the post-install launch exited immediately with
# singleInstance=false — which looks exactly like "the installer never opened it".
$ErrorActionPreference = 'SilentlyContinue'

function OurPids {
  # Real Windows svchosts run as SYSTEM in session 0; ours always run in the
  # interactive session. ExecutablePath is unreadable for an elevated image from a
  # non-elevated or 32-bit PowerShell, so the path alone cannot be trusted — with
  # the old filter every elevated instance survived the install and kept the
  # single-instance lock, piling up until nothing could start any more.
  @(
    Get-CimInstance Win32_Process -Filter "Name='Glance AI.exe'" |
      Where-Object {
        $_.SessionId -ne 0 -and
        ($_.ExecutablePath -like '*\Glance AI\Glance AI.exe' -or [string]::IsNullOrEmpty($_.ExecutablePath))
      } |
      Select-Object -ExpandProperty ProcessId
  )
}

foreach ($procId in (OurPids)) {
  try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
}

# let a killed instance release its single-instance lock before the next start
for ($i = 0; $i -lt 20; $i++) {
  if ((OurPids).Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
}

Start-Sleep -Milliseconds 300
exit 0

