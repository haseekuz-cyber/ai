[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][int]$CenterX,
    [Parameter(Mandatory = $true)][int]$CenterY,
    [int]$Width = 220,
    [int]$Height = 220,
    [int]$Scale = 3
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Drawing

if ($Width -lt 32 -or $Height -lt 32 -or $Width -gt 1200 -or $Height -gt 1200) {
    throw 'Crop dimensions must be between 32 and 1200 pixels.'
}
if ($Scale -lt 1 -or $Scale -gt 6) {
    throw 'Scale must be between 1 and 6.'
}

$source = [System.Drawing.Bitmap]::FromFile([System.IO.Path]::GetFullPath($InputPath))
try {
    $cropWidth = [Math]::Min($Width, $source.Width)
    $cropHeight = [Math]::Min($Height, $source.Height)
    $left = [Math]::Max(0, [Math]::Min($source.Width - $cropWidth, $CenterX - [int]($cropWidth / 2)))
    $top = [Math]::Max(0, [Math]::Min($source.Height - $cropHeight, $CenterY - [int]($cropHeight / 2)))
    $sourceRectangle = [System.Drawing.Rectangle]::new($left, $top, $cropWidth, $cropHeight)
    $outputWidth = $cropWidth * $Scale
    $outputHeight = $cropHeight * $Scale
    $target = [System.Drawing.Bitmap]::new($outputWidth, $outputHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($target)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
            $graphics.DrawImage(
                $source,
                [System.Drawing.Rectangle]::new(0, 0, $outputWidth, $outputHeight),
                $sourceRectangle,
                [System.Drawing.GraphicsUnit]::Pixel
            )
        }
        finally {
            $graphics.Dispose()
        }

        $outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
        $outputDirectory = [System.IO.Path]::GetDirectoryName($outputFullPath)
        [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
        $target.Save($outputFullPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $hash = (Get-FileHash -LiteralPath $outputFullPath -Algorithm SHA256).Hash
        [pscustomobject]@{
            schemaVersion = 1
            sourceBounds = [pscustomobject]@{ x = $left; y = $top; width = $cropWidth; height = $cropHeight }
            outputBounds = [pscustomobject]@{ x = 0; y = 0; width = $outputWidth; height = $outputHeight }
            outputPath = $outputFullPath
            sha256 = $hash
        } | ConvertTo-Json -Compress
    }
    finally {
        $target.Dispose()
    }
}
finally {
    $source.Dispose()
}

