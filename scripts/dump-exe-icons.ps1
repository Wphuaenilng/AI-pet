# Dump every RT_ICON frame from a PE file and render each frame to PNG
# (handles both PNG-compressed and BMP frames) so the embedded icon can be
# verified visually. Usage: powershell -NoProfile -File scripts/dump-exe-icons.ps1 <exe> <outDir>
param(
  [string]$Exe = 'C:\Users\Administrator\AppData\Local\Temp\icon-check2.exe',
  [string]$OutDir = 'C:\Users\Administrator\AppData\Local\Temp\exe-icons'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Runtime.InteropServices;
public static class Res {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryExW(string file, IntPtr handle, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll")]
  public static extern uint SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LockResource(IntPtr resource);
}
'@
Add-Type -TypeDefinition $src

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

$module = [Res]::LoadLibraryExW($Exe, [IntPtr]::Zero, 2) # LOAD_LIBRARY_AS_DATAFILE
if ($module -eq [IntPtr]::Zero) { throw 'LoadLibraryEx failed' }

$found = 0
foreach ($id in 1..16) {
  $res = [Res]::FindResourceW($module, [IntPtr]$id, [IntPtr]3) # RT_ICON
  if ($res -eq [IntPtr]::Zero) { continue }
  $size = [int][Res]::SizeofResource($module, $res)
  $ptr = [Res]::LockResource([Res]::LoadResource($module, $res))
  $bytes = New-Object byte[] $size
  [System.Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size)
  $ms = New-Object System.IO.MemoryStream
  $ms.Write($bytes, 0, $size)
  $ms.Position = 0

  try {
    if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) {
      # PNG frame
      $img = [System.Drawing.Image]::FromStream($ms)
    } else {
      # BMP frame: BITMAPINFOHEADER + BGRA rows bottom-up (height doubled for AND mask)
      $ms.Position = 0
      $br = New-Object System.IO.BinaryReader($ms)
      $null = $br.ReadUInt32() # header size
      $w = $br.ReadInt32()
      $hRaw = $br.ReadInt32()
      $h = [Math]::Abs($hRaw) / 2
      $bpp = $br.ReadUInt16()
      if ($bpp -ne 32) { Write-Host "RT_ICON id=$id ${w}x${h} bpp=$bpp (unsupported)"; $ms.Dispose(); continue }
      $null = $br.ReadUInt16()
      $ms.Position = 40
      $img = New-Object System.Drawing.Bitmap($w, $h)
      for ($y = 0; $y -lt $h; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
          $b = $br.ReadByte(); $gg = $br.ReadByte(); $r = $br.ReadByte(); $a = $br.ReadByte()
          $img.SetPixel($x, $h - 1 - $y, [System.Drawing.Color]::FromArgb($a, $r, $gg, $b))
        }
      }
      $br.Dispose()
    }
    $out = Join-Path $OutDir ("icon-{0}.png" -f $id)
    $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("RT_ICON id={0} {1}x{2} -> {3}" -f $id, $img.Width, $img.Height, $out)
    $img.Dispose()
    $found++
  } catch {
    Write-Host "RT_ICON id=$id decode failed: $_"
  }
  $ms.Dispose()
}
Write-Host "frames: $found"
