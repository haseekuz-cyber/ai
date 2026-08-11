[CmdletBinding()]
param(
    [Parameter(Mandatory)][long]$WindowHandle,
    [Parameter(Mandatory)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WindowCaptureNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr windowHandle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr windowHandle, out Rect rectangle);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PrintWindow(IntPtr windowHandle, IntPtr deviceContext, uint flags);
}
'@

$handle = [System.IntPtr]::new($WindowHandle)
if (-not [WindowCaptureNative]::IsWindow($handle)) {
    throw "Window handle $WindowHandle is not valid."
}

$rectangle = [WindowCaptureNative+Rect]::new()
if (-not [WindowCaptureNative]::GetWindowRect($handle, [ref]$rectangle)) {
    throw 'GetWindowRect failed.'
}

$width = $rectangle.Right - $rectangle.Left
$height = $rectangle.Bottom - $rectangle.Top
if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192) {
    throw "Invalid window dimensions: ${width}x${height}."
}

$resolvedOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::Black)
$deviceContext = $graphics.GetHdc()

try {
    $captured = [WindowCaptureNative]::PrintWindow($handle, $deviceContext, 2)
}
finally {
    $graphics.ReleaseHdc($deviceContext)
    $graphics.Dispose()
}

try {
    if (-not $captured) {
        throw 'PrintWindow did not return a frame for this application.'
    }
    $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $bitmap.Dispose()
}

$file = Get-Item -LiteralPath $resolvedOutput
$hash = Get-FileHash -LiteralPath $resolvedOutput -Algorithm SHA256
[ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    windowHandle = $WindowHandle
    bounds = [ordered]@{
        x = $rectangle.Left
        y = $rectangle.Top
        width = $width
        height = $height
    }
    outputPath = $resolvedOutput
    bytes = $file.Length
    sha256 = $hash.Hash
} | ConvertTo-Json -Depth 5 -Compress
