# Register the vendored UnityCapture DirectShow filter as a per-user virtual
# camera. Per-user (HKCU) needs no elevation, which is what makes this testable
# without a UAC prompt; the packaged installer registers the same keys under
# HKLM for every user on the machine.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\vcam-install.ps1 [-Name "HD User Facing (VC)"] [-Uninstall]
param(
  [string]$Name = 'HD User Facing (VC)',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'vendor\unitycapture'
$dest = Join-Path $env:LOCALAPPDATA 'Glance AI\vcam'

$cats = @{
  x64 = '{860BB310-5D01-11D0-BD3B-00A0C911CE86}'
  x86 = '{860BB310-5D01-11D0-BD3B-00A0C911CE86}'
}
# 64-bit filter uses ...0010, 32-bit uses ...0020 (separate GUIDs so both can
# register without a 64-bit process loading the 32-bit DLL)
$filters = @(
  @{ arch = 'x64'; clsid = '{5C2CD55C-92AD-4999-8666-912BD3E70010}'; dll = 'UnityCaptureFilter64.dll'; view = 'HKCU:\Software\Classes' },
  @{ arch = 'x86'; clsid = '{5C2CD55C-92AD-4999-8666-912BD3E70020}'; dll = 'UnityCaptureFilter32.dll'; view = 'HKCU:\Software\Classes\Wow6432Node' }
)

if ($Uninstall) {
  foreach ($f in $filters) {
    $inst = "$($f.view)\CLSID\$($cats[$f.arch])\Instance\$($f.clsid)"
    Remove-Item -Path $inst -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path "$($f.view)\CLSID\$($f.clsid)" -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "vcam: unregistered and removed $dest"
  exit 0
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($f in $filters) {
  $src = Join-Path $vendor $f.dll
  if (-not (Test-Path $src)) { continue }
  $dll = Join-Path $dest $f.dll
  Copy-Item $src $dll -Force

  $base = "$($f.view)\CLSID\$($f.clsid)"
  New-Item -Path "$base\InprocServer32" -Force | Out-Null
  Set-ItemProperty -Path $base -Name '(default)' -Value 'Runtime Camera' -ErrorAction SilentlyContinue
  Set-ItemProperty -Path "$base\InprocServer32" -Name '(default)' -Value $dll
  Set-ItemProperty -Path "$base\InprocServer32" -Name 'ThreadingModel' -Value 'Both'

  $inst = "$($f.view)\CLSID\$($cats[$f.arch])\Instance\$($f.clsid)"
  New-Item -Path $inst -Force | Out-Null
  Set-ItemProperty -Path $inst -Name 'CLSID' -Value $f.clsid
  Set-ItemProperty -Path $inst -Name 'FriendlyName' -Value $Name
  # UnityCapture's own installer writes this so Skype/Unity can open the device
  Set-ItemProperty -Path $inst -Name 'DevicePath' -Value 'foo:bar'
  Write-Host "vcam: registered $($f.arch) $($f.clsid) as '$Name'"
}
Write-Host "vcam: DLLs at $dest ??? restart the consuming app to see the device"

