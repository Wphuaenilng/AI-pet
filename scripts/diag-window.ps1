Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$petHwnd = [IntPtr]723218
$ex = [W]::GetWindowLong($petHwnd, -20)
Write-Output ('pet exstyle=0x{0:x} TOPMOST={1} TRANSPARENT={2} LAYERED={3} NOACTIVATE={4}' -f $ex, (($ex -band 0x8) -ne 0), (($ex -band 0x20) -ne 0), (($ex -band 0x80000) -ne 0), (($ex -band 0x8000000) -ne 0))
Write-Output ('foreground=0x{0:x}' -f [W]::GetForegroundWindow())
$script:found = @()
$cb = [W+EnumProc]{ param($h,$l)
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowText($h,$sb,256)
  $p = 0; [void][W]::GetWindowThreadProcessId($h,[ref]$p)
  $proc = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName
  if ($sb.ToString() -match 'Desktop AI Pet|DeclareMyTask|AiQualityCheck|检验端|在线工作进度') {
    $r = New-Object W+RECT; [void][W]::GetWindowRect($h,[ref]$r)
    $script:found += ('{0} | {1} | {2} | rect={3},{4},{5},{6} vis={7}' -f $h, $proc, $sb.ToString(), $r.Left,$r.Top,$r.Right,$r.Bottom, [W]::IsWindowVisible($h))
  }
  return $true
}
[W]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$script:found
