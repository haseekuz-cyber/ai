[CmdletBinding()]
param(
    [Parameter(Mandatory)][long]$WindowHandle,
    [ValidateSet('restoreNoActivate', 'click')][string]$Operation,
    [int]$X,
    [int]$Y,
    [int]$AllowedX = 1920,
    [int]$AllowedY = 0,
    [int]$AllowedWidth = 1920,
    [int]$AllowedHeight = 1080,
    [switch]$Confirmed
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AiWindowMessageNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WindowPlacement
    {
        public int Length;
        public int Flags;
        public int ShowCmd;
        public Point MinPosition;
        public Point MaxPosition;
        public Rect NormalPosition;
    }

    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, ref WindowPlacement placement);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref Point point);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

function Test-InAllowedDisplay {
    param([int]$PointX, [int]$PointY)
    return (
        $PointX -ge $AllowedX -and $PointX -lt ($AllowedX + $AllowedWidth) -and
        $PointY -ge $AllowedY -and $PointY -lt ($AllowedY + $AllowedHeight)
    )
}

$handle = [IntPtr]::new($WindowHandle)
if (-not [AiWindowMessageNative]::IsWindow($handle)) { throw 'Target window is not valid.' }
$processId = [uint32]0
[void][AiWindowMessageNative]::GetWindowThreadProcessId($handle, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction Stop
if ($process.ProcessName -ne 'Telegram') { throw 'This pilot accepts only Telegram windows.' }

$cursorBefore = [System.Windows.Forms.Cursor]::Position
$foregroundBefore = [AiWindowMessageNative]::GetForegroundWindow().ToInt64()
$rect = [AiWindowMessageNative+Rect]::new()
if (-not [AiWindowMessageNative]::GetWindowRect($handle, [ref]$rect)) { throw 'GetWindowRect failed.' }

if ($Operation -eq 'restoreNoActivate') {
    $placement = [AiWindowMessageNative+WindowPlacement]::new()
    $placement.Length = [Runtime.InteropServices.Marshal]::SizeOf($placement)
    if (-not [AiWindowMessageNative]::GetWindowPlacement($handle, [ref]$placement)) { throw 'GetWindowPlacement failed.' }
    $normal = $placement.NormalPosition
    $centerX = [int](($normal.Left + $normal.Right) / 2)
    $centerY = [int](($normal.Top + $normal.Bottom) / 2)
    if (-not (Test-InAllowedDisplay -PointX $centerX -PointY $centerY)) { throw 'Stored window position is outside the AI display.' }
    [void][AiWindowMessageNative]::ShowWindowAsync($handle, 4)
    Start-Sleep -Milliseconds 150
    $width = $normal.Right - $normal.Left
    $height = $normal.Bottom - $normal.Top
    $flags = 0x0010 -bor 0x0040 # SWP_NOACTIVATE | SWP_SHOWWINDOW
    if (-not [AiWindowMessageNative]::SetWindowPos($handle, [IntPtr]::new(-1), $normal.Left, $normal.Top, $width, $height, $flags)) {
        throw 'SetWindowPos failed.'
    }
}
else {
    if (-not $Confirmed) { throw 'confirmed is required for window navigation.' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($X -lt 80 -or $X -gt 540 -or $Y -lt 80 -or $Y -gt ($height - 40)) {
        throw 'Click point is outside the read-only Telegram chat-list region.'
    }
    $screenX = $rect.Left + $X
    $screenY = $rect.Top + $Y
    if (-not (Test-InAllowedDisplay -PointX $screenX -PointY $screenY)) { throw 'Click point is outside the AI display.' }
    $point = [AiWindowMessageNative+Point]::new()
    $point.X = $screenX
    $point.Y = $screenY
    if (-not [AiWindowMessageNative]::ScreenToClient($handle, [ref]$point)) { throw 'ScreenToClient failed.' }
    $packed = (($point.Y -band 0xFFFF) -shl 16) -bor ($point.X -band 0xFFFF)
    [void][AiWindowMessageNative]::PostMessage($handle, 0x0200, [UIntPtr]::Zero, [IntPtr]::new($packed))
    [void][AiWindowMessageNative]::PostMessage($handle, 0x0201, [UIntPtr]::new(1), [IntPtr]::new($packed))
    [void][AiWindowMessageNative]::PostMessage($handle, 0x0202, [UIntPtr]::Zero, [IntPtr]::new($packed))
    Start-Sleep -Milliseconds 300
}

$cursorAfter = [System.Windows.Forms.Cursor]::Position
$foregroundAfter = [AiWindowMessageNative]::GetForegroundWindow().ToInt64()
[ordered]@{
    ok = $true
    operation = $Operation
    windowHandle = $WindowHandle
    processName = $process.ProcessName
    systemPointer = [ordered]@{
        usedByAction = $false
        before = [ordered]@{ x = $cursorBefore.X; y = $cursorBefore.Y }
        after = [ordered]@{ x = $cursorAfter.X; y = $cursorAfter.Y }
    }
    foreground = [ordered]@{
        requested = $false
        before = $foregroundBefore
        after = $foregroundAfter
        changedByOperation = ($foregroundBefore -ne $foregroundAfter)
    }
} | ConvertTo-Json -Depth 5 -Compress

