# Generates image assets for the app using GDI+ (no external deps):
#  - avatars (128px) from the two mascot illustrations
#  - app/tray icon PNGs (rounded tile, from the fox) at 16/32/48/256
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'design-assets'
$outIcons = Join-Path $root 'src-tauri\icons'
$outAvatars = Join-Path $root 'public\avatars'
New-Item -ItemType Directory -Force -Path $outIcons, $outAvatars | Out-Null

$fox = Join-Path $assets 'A_cute_desktop_AI_virtual_pet__2026-08-30T09-19-36.png'
$cream = Join-Path $assets 'A_cute_chubby_desktop_AI_virtu_2026-08-30T09-19-36.png'

function Resize-Square([string]$src, [int]$size, [string]$dst, [bool]$round) {
  $img = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  if ($round) {
    $r = [Math]::Max(2, [int]($size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()
    $g.SetClip($path)
  }

  # center-crop the source to a square before drawing
  $side = [Math]::Min($img.Width, $img.Height)
  $sx = [int](($img.Width - $side) / 2)
  $sy = [int](($img.Height - $side) / 2)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $srcRect = New-Object System.Drawing.Rectangle($sx, $sy, $side, $side)
  $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

  $g.Dispose()
  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $img.Dispose()
  Write-Host "wrote $dst"
}

# avatars
Resize-Square $cream 128 (Join-Path $outAvatars 'pet-cream.png') $true
Resize-Square $fox 128 (Join-Path $outAvatars 'pet-fox.png') $true

# icon tiles from the fox
Resize-Square $fox 256 (Join-Path $outIcons 'icon_256.png') $true
Resize-Square $fox 48 (Join-Path $outIcons 'icon_48.png') $true
Resize-Square $fox 32 (Join-Path $outIcons 'icon_32.png') $true
Resize-Square $fox 16 (Join-Path $outIcons 'icon_16.png') $true

Write-Host 'assets done'
