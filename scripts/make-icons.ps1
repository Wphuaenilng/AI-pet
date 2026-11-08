# Generate the app icon: blue gradient rounded-square + the dot-pet face.
# Drawn once at 1024px master, then high-quality downscaled per size so small
# icons stay smooth. Outputs src-tauri/icons/{icon.png, icon_*.png, 32x32.png, icon.ico}.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-icons.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path $PSScriptRoot '..\src-tauri\icons'
$Master = 1024

function New-MasterBitmap([int]$master) {
  $bmp = New-Object System.Drawing.Bitmap($master, $master)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # rounded-square background: diagonal blue gradient (app accent)
  $radius = $master * 0.23
  $rect = New-Object System.Drawing.Rectangle(0, 0, $master, $master)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($master, $master)),
    [System.Drawing.Color]::FromArgb(255, 74, 163, 255),
    [System.Drawing.Color]::FromArgb(255, 9, 95, 214))
  $g.FillPath($grad, $path)

  # soft top sheen on the background
  $sheen = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(50, 255, 255, 255),
    [System.Drawing.Color]::FromArgb(0, 255, 255, 255),
    90)
  $g.FillPath($sheen, $path)

  # the dot: slightly below center, near-black
  $ink = [System.Drawing.Color]::FromArgb(255, 26, 26, 28)
  $dotR = $master * 0.315
  $cx = $master * 0.5
  $cy = $master * 0.535
  $inkBrush = New-Object System.Drawing.SolidBrush($ink)
  $g.FillEllipse($inkBrush, $cx - $dotR, $cy - $dotR, 2 * $dotR, 2 * $dotR)

  # crescent highlight on the dot's top-left (like the desktop rendering)
  $hl = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 255, 255, 255), [float]($master * 0.055))
  $hl.StartCap = 'Round'; $hl.EndCap = 'Round'
  $g.DrawArc($hl, $cx - $dotR * 0.72, $cy - $dotR * 0.72, $dotR * 1.44, $dotR * 1.44, 205, 95)
  $hl.Dispose()

  # eyes: two white vertical ovals
  $white = [System.Drawing.Brushes]::White
  $ew = $master * 0.115
  $eh = $master * 0.175
  $eyeY = $cy - $master * 0.035
  $g.FillEllipse($white, $cx - $master * 0.115 - $ew / 2, $eyeY - $eh / 2, $ew, $eh)
  $g.FillEllipse($white, $cx + $master * 0.115 - $ew / 2, $eyeY - $eh / 2, $ew, $eh)

  # smile
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]($master * 0.045))
  $sw = $master * 0.30
  $g.DrawArc($pen, $cx - $sw / 2, $cy + $master * 0.03, $sw, $master * 0.28, 25, 130)

  $pen.Dispose(); $inkBrush.Dispose(); $grad.Dispose(); $sheen.Dispose()
  $path.Dispose(); $g.Dispose()
  return $bmp
}

$masterBmp = New-MasterBitmap $Master

function Save-Size([int]$size, [string]$path) {
  $out = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($masterBmp, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.Dispose()
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Host "PNG  $((Resolve-Path $path).Path)"
}

function Save-Ico([string]$path, [int[]]$sizes) {
  # ICO container: directory entries + embedded PNGs (Vista+, works for Tauri/Explorer)
  $entries = @()
  foreach ($s in $sizes) {
    $tmp = [System.IO.Path]::GetTempFileName()
    Save-Size $s $tmp | Out-Null
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    [System.IO.File]::Delete($tmp)
    $entries += ,@{ Size = $s; Bytes = $bytes }
  }
  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
  $offset = 6 + 16 * $entries.Count
  foreach ($e in $entries) {
    $b = if ($e.Size -ge 256) { 0 } else { $e.Size }
    $bw.Write([byte]$b); $bw.Write([byte]$b)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$e.Bytes.Length)
    $bw.Write([uint32]$offset)
    $offset += $e.Bytes.Length
  }
  foreach ($e in $entries) { $bw.Write($e.Bytes) }
  $bw.Dispose(); $fs.Dispose()
  Write-Host "ICO  $((Resolve-Path $path).Path)"
}

Save-Size 512  (Join-Path $OutDir 'icon.png')
Save-Size 256  (Join-Path $OutDir 'icon_256.png')
Save-Size 48   (Join-Path $OutDir 'icon_48.png')
Save-Size 32   (Join-Path $OutDir 'icon_32.png')
Save-Size 32   (Join-Path $OutDir '32x32.png')
Save-Size 16   (Join-Path $OutDir 'icon_16.png')
Save-Ico (Join-Path $OutDir 'icon.ico') @(16, 24, 32, 48, 64, 128, 256)
$masterBmp.Dispose()
Write-Host 'done'
