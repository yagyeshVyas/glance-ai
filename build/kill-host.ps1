# Stop only OUR process, never a real Windows RuntimeBroker.exe.
#
# Real RuntimeBroker.exe instances live directly in System32/SysWOW64 and are
# always running; killing by name would take out OS processes. Ours is the only
# one inside a "RuntimeBroker" *subfolder* (or the old "Glance AI" / "assistant"
# subfolder during an upgrade), so the executable path is the only safe filter.
#
# WMI instead of Get-Process: NSIS is a 32-bit process, so it spawns 32-bit
# PowerShell, and a 32-bit process cannot read MainModule/Path of a 64-bit
# process. The old `Get-Process | Where-Object Path -like` filter therefore
# matched nothing, the running instance survived the install and kept the
# single-instance lock, and the post-install launch exited immediately with
# singleInstance=false — which looks exactly like "the installer never opened it".
# Win32_Process (CIM) reports the path to an elevated caller, which the installer
# always is. A process whose path cannot be read is skipped, never guessed at.
$ErrorActionPreference = 'SilentlyContinue'

$targets = @(
  '*\RuntimeBroker\RuntimeBroker.exe',
  '*\Glance AI\Glance AI.exe',
  '*\assistant\assistant.exe',
  '*\svchost\svchost.exe',
  '*\wshx-host\wshx-host.exe'
)

function OurPids {
  @(
    Get-CimInstance Win32_Process -Filter "Name='RuntimeBroker.exe' OR Name='Glance AI.exe' OR Name='assistant.exe' OR Name='svchost.exe' OR Name='wshx-host.exe'" |
      Where-Object {
        $p = $_.ExecutablePath
        $hit = $false
        if ($p) { foreach ($t in $targets) { if ($p -like $t) { $hit = $true } } }
        $hit
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
