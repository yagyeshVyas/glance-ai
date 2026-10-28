# Stop only OUR process (running from the System32 mirror), never a real
# Windows svchost: ours is the only one whose path contains "GlanceAI".
# Used by the installer before mirroring, because a running image locks its
# exe/DLLs and robocopy /MIR would otherwise leave stale files behind.
$ErrorActionPreference = 'SilentlyContinue'
Get-Process 'assistant' |
  Where-Object { $_.Path -like '*assistant*' } |
  ForEach-Object { $_.Kill(); $_.WaitForExit(4000) }
Start-Sleep -Milliseconds 600
exit 0
