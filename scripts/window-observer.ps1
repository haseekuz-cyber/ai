[CmdletBinding()]
param(
    [Parameter(Mandatory)][long]$WindowHandle,
    [Parameter(Mandatory)][int]$ParentProcessId,
    [int]$IntervalMs = 300,
    [int]$Columns = 32,
    [int]$Rows = 18,
    [double]$CellDeltaThreshold = 0.045,
    [string]$KeyframeDirectory = '',
    [int]$KeyframeMinIntervalMs = 450,
    [int]$KeyframeMaxWidth = 960,
    [int]$CaptureX = 0,
    [int]$CaptureY = 0,
    [int]$CaptureWidth = 0,
    [int]$CaptureHeight = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WindowObserverNative
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

function Write-ObserverEvent {
    param([Parameter(Mandatory)]$Value)
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Depth 7 -Compress))
    [Console]::Out.Flush()
}

function Test-ParentAlive {
    try {
        Get-Process -Id $ParentProcessId -ErrorAction Stop | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Get-SampleBytes {
    param(
        [Parameter(Mandatory)][System.Drawing.Bitmap]$Bitmap,
        [Parameter(Mandatory)][int]$SampleColumns,
        [Parameter(Mandatory)][int]$SampleRows
    )

    $bytes = [byte[]]::new($SampleColumns * $SampleRows * 3)
    $offset = 0
    for ($row = 0; $row -lt $SampleRows; $row++) {
        for ($column = 0; $column -lt $SampleColumns; $column++) {
            $red = 0
            $green = 0
            $blue = 0
            foreach ($fractionY in @(0.25, 0.75)) {
                foreach ($fractionX in @(0.25, 0.75)) {
                    $x = [math]::Min($Bitmap.Width - 1, [math]::Max(0,
                        [int][math]::Floor((($column + $fractionX) / $SampleColumns) * $Bitmap.Width)))
                    $y = [math]::Min($Bitmap.Height - 1, [math]::Max(0,
                        [int][math]::Floor((($row + $fractionY) / $SampleRows) * $Bitmap.Height)))
                    $color = $Bitmap.GetPixel($x, $y)
                    $red += $color.R
                    $green += $color.G
                    $blue += $color.B
                }
            }
            $bytes[$offset] = [byte][math]::Round($red / 4)
            $bytes[$offset + 1] = [byte][math]::Round($green / 4)
            $bytes[$offset + 2] = [byte][math]::Round($blue / 4)
            $offset += 3
        }
    }
    return $bytes
}

function Get-Signature {
    param([Parameter(Mandatory)][byte[]]$Bytes)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
    }
}

function Save-ObserverKeyframe {
    param(
        [Parameter(Mandatory)][System.Drawing.Bitmap]$Bitmap,
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][long]$Handle,
        [Parameter(Mandatory)][int]$Sequence,
        [Parameter(Mandatory)][int]$MaximumWidth
    )
    $preview = $null
    $previewGraphics = $null
    try {
        $targetWidth = [math]::Min($Bitmap.Width, $MaximumWidth)
        $targetHeight = [math]::Max(1, [int][math]::Round($Bitmap.Height * ($targetWidth / [double]$Bitmap.Width)))
        $imageToSave = $Bitmap
        if ($targetWidth -ne $Bitmap.Width) {
            $preview = [System.Drawing.Bitmap]::new($targetWidth, $targetHeight, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $previewGraphics = [System.Drawing.Graphics]::FromImage($preview)
            $previewGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
            $previewGraphics.DrawImage($Bitmap, 0, 0, $targetWidth, $targetHeight)
            $imageToSave = $preview
        }
        $fileName = 'stream-{0}-{1}-{2}-{3}.png' -f $Handle, $ParentProcessId, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $Sequence
        $filePath = Join-Path $Directory $fileName
        $imageToSave.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)
        return $filePath
    }
    finally {
        if ($null -ne $previewGraphics) { $previewGraphics.Dispose() }
        if ($null -ne $preview) { $preview.Dispose() }
    }
}

$IntervalMs = [math]::Min(2000, [math]::Max(100, $IntervalMs))
$Columns = [math]::Min(64, [math]::Max(8, $Columns))
$Rows = [math]::Min(36, [math]::Max(6, $Rows))
$CellDeltaThreshold = [double][math]::Min(1.0, [math]::Max(0.005, [double]$CellDeltaThreshold))
$KeyframeMinIntervalMs = [math]::Min(5000, [math]::Max(200, $KeyframeMinIntervalMs))
$KeyframeMaxWidth = [math]::Min(1920, [math]::Max(480, $KeyframeMaxWidth))
if ($KeyframeDirectory) {
    $KeyframeDirectory = [System.IO.Path]::GetFullPath($KeyframeDirectory)
    [System.IO.Directory]::CreateDirectory($KeyframeDirectory) | Out-Null
}
$handle = [System.IntPtr]::new($WindowHandle)
$previousBytes = $null
$previousSignature = $null
$previousBounds = $null
$previousTargetBounds = $null
$sequence = 0
$consecutiveErrors = 0
$lastKeyframeAt = [DateTimeOffset]::MinValue

while (Test-ParentAlive) {
    $started = [System.Diagnostics.Stopwatch]::StartNew()
    $bitmap = $null
    $graphics = $null
    try {
        if (-not [WindowObserverNative]::IsWindow($handle)) {
            Write-ObserverEvent ([ordered]@{ type = 'ended'; reason = 'window_closed'; windowHandle = $WindowHandle })
            break
        }

        $rectangle = [WindowObserverNative+Rect]::new()
        if (-not [WindowObserverNative]::GetWindowRect($handle, [ref]$rectangle)) {
            throw 'GetWindowRect failed.'
        }
        $targetBounds = [ordered]@{
            x = $rectangle.Left
            y = $rectangle.Top
            width = $rectangle.Right - $rectangle.Left
            height = $rectangle.Bottom - $rectangle.Top
        }
        $left = if ($CaptureWidth -gt 0 -and $CaptureHeight -gt 0) { $CaptureX } else { $rectangle.Left }
        $top = if ($CaptureWidth -gt 0 -and $CaptureHeight -gt 0) { $CaptureY } else { $rectangle.Top }
        $width = if ($CaptureWidth -gt 0 -and $CaptureHeight -gt 0) { $CaptureWidth } else { $targetBounds.width }
        $height = if ($CaptureWidth -gt 0 -and $CaptureHeight -gt 0) { $CaptureHeight } else { $targetBounds.height }
        if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192) {
            throw "Invalid window dimensions: ${width}x${height}."
        }

        $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($left, $top, 0, 0, [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)

        [byte[]]$sampleBytes = @(Get-SampleBytes -Bitmap $bitmap -SampleColumns $Columns -SampleRows $Rows)
        $signature = Get-Signature -Bytes $sampleBytes
        $bounds = [ordered]@{ x = $left; y = $top; width = $width; height = $height }
        $geometryChanged = $null -ne $previousTargetBounds -and (
            $previousTargetBounds.x -ne $targetBounds.x -or $previousTargetBounds.y -ne $targetBounds.y -or
            $previousTargetBounds.width -ne $targetBounds.width -or $previousTargetBounds.height -ne $targetBounds.height
        )
        $changedCells = [System.Collections.Generic.List[object]]::new()
        if ($null -ne $previousBytes -and $previousSignature -ne $signature -and $previousBytes.Length -eq $sampleBytes.Length) {
            for ($cell = 0; $cell -lt ($Columns * $Rows); $cell++) {
                $offset = $cell * 3
                $redDelta = [math]::Abs(([int]$sampleBytes[$offset]) - ([int]$previousBytes[$offset]))
                $greenDelta = [math]::Abs(([int]$sampleBytes[$offset + 1]) - ([int]$previousBytes[$offset + 1]))
                $blueDelta = [math]::Abs(([int]$sampleBytes[$offset + 2]) - ([int]$previousBytes[$offset + 2]))
                $delta = ($redDelta + $greenDelta + $blueDelta) / (255.0 * 3.0)
                if ($delta -ge $CellDeltaThreshold) {
                    $changedCells.Add([ordered]@{
                        column = $cell % $Columns
                        row = [math]::Floor($cell / $Columns)
                        delta = [math]::Round($delta, 4)
                    })
                }
            }
        }

        $sequence += 1
        $changedFraction = if ($null -eq $previousBytes) { 0 } else { $changedCells.Count / [double]($Columns * $Rows) }
        $now = [DateTimeOffset]::UtcNow
        $keyframePath = $null
        $isFirstFrame = $null -eq $previousBytes
        $isMeaningfulChange = $geometryChanged -or $changedCells.Count -gt 0
        $importance = if ($isFirstFrame) {
            'critical'
        }
        elseif ($geometryChanged -or $changedFraction -ge 0.18) {
            'critical'
        }
        elseif ($changedFraction -ge 0.055) {
            'high'
        }
        elseif ($changedFraction -ge 0.012) {
            'normal'
        }
        else {
            'low'
        }
        $importanceIntervalMs = switch ($importance) {
            'critical' { [math]::Max(200, [int]($KeyframeMinIntervalMs * 0.45)) }
            'high' { [math]::Max(250, [int]($KeyframeMinIntervalMs * 0.7)) }
            'normal' { $KeyframeMinIntervalMs }
            default { [math]::Max(900, [int]($KeyframeMinIntervalMs * 2.0)) }
        }
        if ($KeyframeDirectory -and ($isFirstFrame -or ($isMeaningfulChange -and ($now - $lastKeyframeAt).TotalMilliseconds -ge $importanceIntervalMs))) {
            $keyframePath = Save-ObserverKeyframe -Bitmap $bitmap -Directory $KeyframeDirectory `
                -Handle $WindowHandle -Sequence $sequence -MaximumWidth $KeyframeMaxWidth
            $lastKeyframeAt = $now
        }
        Write-ObserverEvent ([ordered]@{
            schemaVersion = 1
            type = 'frame'
            sequence = $sequence
            capturedAt = (Get-Date).ToUniversalTime().ToString('o')
            windowHandle = $WindowHandle
            bounds = $bounds
            targetWindowBounds = $targetBounds
            columns = $Columns
            rows = $Rows
            signature = $signature
            changedFromPrevious = ($geometryChanged -or $changedCells.Count -gt 0)
            geometryChanged = $geometryChanged
            changedFraction = [math]::Round($changedFraction, 6)
            importance = $importance
            changedCells = @($changedCells)
            keyframePath = $keyframePath
            captureElapsedMs = $started.ElapsedMilliseconds
        })
        $previousBytes = $sampleBytes
        $previousSignature = $signature
        $previousBounds = $bounds
        $previousTargetBounds = $targetBounds
        $consecutiveErrors = 0
    }
    catch {
        $consecutiveErrors += 1
        Write-ObserverEvent ([ordered]@{
            schemaVersion = 1
            type = 'error'
            windowHandle = $WindowHandle
            message = $_.Exception.Message
            consecutiveErrors = $consecutiveErrors
        })
        if ($consecutiveErrors -ge 5) { break }
    }
    finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        $started.Stop()
    }

    $remaining = $IntervalMs - [int]$started.ElapsedMilliseconds
    if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
}
