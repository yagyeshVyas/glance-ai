# What a GDI/PrintWindow capture gets from the wshx-host window — the API family Zoom's
# zVideoUI.dll links (BitBlt/PrintWindow/GetWindowDC) rather than WinRT capture.
#
#   powershell -ExecutionPolicy Bypass -File scripts\printwindow-probe.ps1 -Out shot.png
#
# Prints one JSON line. Blank output on a protected window is the expected result; run
# it with stealth off to confirm the probe can see the window at all.
param([string]$Out = 'printwindow.png', [string]$Title = 'wshx-host')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@
[void][PW]::SetProcessDPIAware()
$script:target = [IntPtr]::Zero
$cb = [PW+EnumProc] {
  param($h, $p)
  if (-not [PW]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][PW]::GetWindowTextW($h, $sb, 512)
  if ($sb.ToString() -eq $Title) { $script:target = $h; return $false }
  return $true
}
[void][PW]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:target -eq [IntPtr]::Zero) { '{"error":"window not found"}'; exit 2 }
$r = New-Object PW+RECT
[void][PW]::GetWindowRect($script:target, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { '{"error":"empty window rect"}'; exit 2 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [PW]::PrintWindow($script:target, $hdc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$sum = 0.0; $lit = 0; $n = 0
for ($y = 0; $y -lt $h; $y += 2) {
  for ($x = 0; $x -lt $w; $x += 2) {
    $c = $bmp.GetPixel($x, $y)
    $l = 0.2126 * $c.R + 0.7152 * $c.G + 0.0722 * $c.B
    $sum += $l
    if ($l -gt 8) { $lit++ }
    $n++
  }
}
$bmp.Dispose()
[pscustomobject]@{
  out          = $Out
  printWindowOk = $ok
  w            = $w
  h            = $h
  sampled      = $n
  meanLuma     = [math]::Round($sum / $n, 2)
  litFraction  = [math]::Round($lit / $n, 4)
} | ConvertTo-Json -Compress
