[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DeviceName,

    [Parameter(Mandatory)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$LiteralPath)
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

$matches = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.DeviceName -eq $DeviceName })
if ($matches.Count -ne 1) {
    throw "Expected exactly one display named '$DeviceName'; found $($matches.Count)."
}

$screen = $matches[0]
$resolvedOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
if ([System.IO.Path]::GetExtension($resolvedOutputPath) -ne '.png') {
    throw 'OutputPath must use the .png extension.'
}

$outputDirectory = Split-Path -Parent $resolvedOutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$bitmap = [System.Drawing.Bitmap]::new($screen.Bounds.Width, $screen.Bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

try {
    $sourcePoint = [System.Drawing.Point]::new($screen.Bounds.X, $screen.Bounds.Y)
    $destinationPoint = [System.Drawing.Point]::Empty
    $graphics.CopyFromScreen($sourcePoint, $destinationPoint, $screen.Bounds.Size)
    $bitmap.Save($resolvedOutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

$file = Get-Item -LiteralPath $resolvedOutputPath
$hash = Get-Sha256Hex -LiteralPath $resolvedOutputPath

[ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    deviceName = [string]$screen.DeviceName
    bounds = [ordered]@{
        x = [int]$screen.Bounds.X
        y = [int]$screen.Bounds.Y
        width = [int]$screen.Bounds.Width
        height = [int]$screen.Bounds.Height
    }
    outputPath = [string]$file.FullName
    bytes = [long]$file.Length
    sha256 = [string]$hash
} | ConvertTo-Json -Depth 4 -Compress
