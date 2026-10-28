Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot '..\logo.jpg'))
$sizes = @(16, 32, 48, 64, 128, 256, 512)
$pngBlobs = @()
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBlobs += ,($ms.ToArray())
    $ms.Dispose()
    $bmp.Dispose()
}
$src.Dispose()
$dataOffset = 6 + 16 * $sizes.Count
$header = New-Object byte[] (6 + 16 * $sizes.Count)
[BitConverter]::GetBytes([UInt16]0).CopyTo($header, 0)
[BitConverter]::GetBytes([UInt16]1).CopyTo($header, 2)
[BitConverter]::GetBytes([UInt16]$sizes.Count).CopyTo($header, 4)
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $off = 6 + $i * 16
    # ICO dimension bytes: 0 means "256 or larger" (256 = 0 in unsigned-byte math)
    $header[$off] = [Math]::Min($s, 256) % 256
    $header[$off+1] = [Math]::Min($s, 256) % 256
    $header[$off+2] = 0
    $header[$off+3] = 0
    [BitConverter]::GetBytes([UInt16]1).CopyTo($header, $off+4)
    [BitConverter]::GetBytes([UInt16]32).CopyTo($header, $off+6)
    [BitConverter]::GetBytes([UInt32]$pngBlobs[$i].Length).CopyTo($header, $off+8)
    [BitConverter]::GetBytes([UInt32]$dataOffset).CopyTo($header, $off+12)
    $dataOffset += $pngBlobs[$i].Length
}
$result = New-Object byte[] $dataOffset
[System.Array]::Copy($header, $result, $header.Length)
$pos = $header.Length
foreach ($blob in $pngBlobs) {
    [System.Array]::Copy($blob, 0, $result, $pos, $blob.Length)
    $pos += $blob.Length
}
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot '..\build\icon.ico'), $result)
Write-Output "icon.ico written: $($result.Length) bytes"
