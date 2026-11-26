<#
.SYNOPSIS
  Removes the Glance AI self-signed code-signing certificate from the machine
  trust store.

.DESCRIPTION
  Builds up to and including 3.3.6 imported a self-signed certificate into
  LocalMachine\Root during install. That made every user on the machine trust a
  private key that lives on a build machine, for any software signed with it.

  Removing the import from the installer stops new machines from being affected.
  It does not clean machines that already installed an older build. Run this
  script elevated on those machines.

  The certificate is identified by thumbprint, not by name, so nothing else is
  touched. Removing it only makes Authenticode report "Unknown publisher" for
  older Glance AI binaries; it does not uninstall the app.

.EXAMPLE
  # See what would be removed, without changing anything
  powershell -NoProfile -ExecutionPolicy Bypass -File .\remove-trust.ps1 -DryRun

.EXAMPLE
  # Remove it (elevated)
  powershell -NoProfile -ExecutionPolicy Bypass -File .\remove-trust.ps1
#>
[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$thumbprints = @(
  '06468B493CB0318832E9894CA756E064DB06AACC', # current Glance AI self-signed cert
  'E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C', # retired publisher
  'DFA561EEFC12632EAACDD0C8CBE20F3B23AC5702'  # RuntimeBroker-era product cert
)

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin -and -not $DryRun) {
  throw 'This script changes LocalMachine certificate stores. Re-run from an elevated PowerShell, or use -DryRun to inspect.'
}

$stores = @('Root', 'TrustedPeople')
$found = 0
$removed = 0

foreach ($store in $stores) {
  $path = "Cert:\LocalMachine\$store"
  if (-not (Test-Path $path)) { continue }
  foreach ($thumb in $thumbprints) {
    $certs = Get-ChildItem -Path $path | Where-Object { $_.Thumbprint -eq $thumb }
    foreach ($cert in $certs) {
      $found++
      $subject = $cert.Subject
      if ($DryRun) {
        Write-Host ("would remove {0}  {1}  {2}" -f $store, $thumb, $subject)
        continue
      }
      try {
        Remove-Item -Path $cert.PSPath -Force
        $removed++
        Write-Host ("removed       {0}  {1}  {2}" -f $store, $thumb, $subject)
      } catch {
        Write-Warning ("could not remove {0}  {1}: {2}" -f $store, $thumb, $_.Exception.Message)
      }
    }
  }
}

if ($found -eq 0) {
  Write-Host 'Nothing to do: none of the Glance AI thumbprints are in LocalMachine\Root or TrustedPeople.'
} elseif ($DryRun) {
  Write-Host ("Dry run: {0} certificate(s) would be removed. Re-run elevated without -DryRun to remove them." -f $found)
} else {
  Write-Host ("Done: {0} of {1} certificate(s) removed." -f $removed, $found)
}
