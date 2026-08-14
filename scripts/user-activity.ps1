[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AiUserActivityNative
{
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

$lastInput = [AiUserActivityNative+LASTINPUTINFO]::new()
$lastInput.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf($lastInput)
if (-not [AiUserActivityNative]::GetLastInputInfo([ref]$lastInput)) { throw 'GetLastInputInfo failed.' }

$cursor = [AiUserActivityNative+POINT]::new()
if (-not [AiUserActivityNative]::GetCursorPos([ref]$cursor)) { throw 'GetCursorPos failed.' }

[ordered]@{
    lastInputTick = [uint64]$lastInput.dwTime
    cursor = [ordered]@{ x = [int]$cursor.X; y = [int]$cursor.Y }
    focusedWindowHandle = [long][AiUserActivityNative]::GetForegroundWindow()
} | ConvertTo-Json -Depth 3 -Compress
