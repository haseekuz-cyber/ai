[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][int]$X,
    [Parameter(Mandatory)][int]$Y,
    [Parameter(Mandatory)][int]$Width,
    [Parameter(Mandatory)][int]$Height
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
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

$resolvedOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutputPath
if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
$source = [System.Drawing.Image]::FromFile($InputPath)
try {
    if ($X -lt 0 -or $Y -lt 0 -or $Width -le 0 -or $Height -le 0 -or
        ($X + $Width) -gt $source.Width -or ($Y + $Height) -gt $source.Height) {
        throw 'Crop rectangle is outside the source image.'
    }
    $bitmap = [System.Drawing.Bitmap]::new($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $Width, $Height), $X, $Y, $Width, $Height, [System.Drawing.GraphicsUnit]::Pixel)
        $bitmap.Save($resolvedOutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}
finally {
    $source.Dispose()
}

$file = Get-Item -LiteralPath $resolvedOutputPath
[ordered]@{
    schemaVersion = 1
    outputPath = [string]$file.FullName
    bounds = [ordered]@{ x = $X; y = $Y; width = $Width; height = $Height }
    bytes = [long]$file.Length
    sha256 = [string](Get-Sha256Hex -LiteralPath $resolvedOutputPath)
} | ConvertTo-Json -Depth 4 -Compress
