[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputPath,
    [int]$RegionLeft = 480,
    [int]$RegionRight = 540,
    [int]$RegionTop = 80,
    [int]$RegionBottom = 1040
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing

function Test-TelegramBlue {
    param([System.Drawing.Color]$Color)
    return (
        $Color.B -gt 170 -and
        $Color.G -gt 80 -and
        $Color.R -lt 140 -and
        ($Color.B - $Color.G) -gt 35
    )
}

$image = [System.Drawing.Bitmap]::FromFile($InputPath)
try {
    $left = [Math]::Max(0, $RegionLeft)
    $right = [Math]::Min($image.Width, $RegionRight)
    $top = [Math]::Max(0, $RegionTop)
    $bottom = [Math]::Min($image.Height, $RegionBottom)
    $activeRows = [System.Collections.Generic.List[object]]::new()

    for ($y = $top; $y -lt $bottom; $y++) {
        $count = 0
        $minX = [int]::MaxValue
        $maxX = [int]::MinValue
        for ($x = $left; $x -lt $right; $x++) {
            if (Test-TelegramBlue -Color $image.GetPixel($x, $y)) {
                $count++
                if ($x -lt $minX) { $minX = $x }
                if ($x -gt $maxX) { $maxX = $x }
            }
        }
        if ($count -ge 4) {
            $activeRows.Add([pscustomobject]@{ y = $y; count = $count; minX = $minX; maxX = $maxX })
        }
    }

    $bands = [System.Collections.Generic.List[object]]::new()
    $current = $null
    foreach ($row in $activeRows) {
        if ($null -eq $current -or $row.y -gt ($current.maxY + 1)) {
            if ($null -ne $current) { $bands.Add($current) }
            $current = [pscustomobject]@{
                minX = [int]$row.minX
                maxX = [int]$row.maxX
                minY = [int]$row.y
                maxY = [int]$row.y
                pixels = [int]$row.count
            }
        }
        else {
            $current.maxY = [int]$row.y
            $current.pixels += [int]$row.count
            if ($row.minX -lt $current.minX) { $current.minX = [int]$row.minX }
            if ($row.maxX -gt $current.maxX) { $current.maxX = [int]$row.maxX }
        }
    }
    if ($null -ne $current) { $bands.Add($current) }

    $badges = @($bands | ForEach-Object {
        $width = $_.maxX - $_.minX + 1
        $height = $_.maxY - $_.minY + 1
        if ($width -ge 12 -and $width -le 30 -and $height -ge 12 -and $height -le 30 -and $_.pixels -ge 80) {
            $centerY = [int][Math]::Round(($_.minY + $_.maxY) / 2)
            [ordered]@{
                bounds = [ordered]@{ x = $_.minX; y = $_.minY; width = $width; height = $height }
                center = [ordered]@{ x = [int][Math]::Round(($_.minX + $_.maxX) / 2); y = $centerY }
                chatClickPoint = [ordered]@{ x = 300; y = $centerY }
                pixels = $_.pixels
            }
        }
    })

    [ordered]@{
        schemaVersion = 1
        source = (Resolve-Path -LiteralPath $InputPath).Path
        image = [ordered]@{ width = $image.Width; height = $image.Height }
        region = [ordered]@{ x = $left; y = $top; width = ($right - $left); height = ($bottom - $top) }
        count = $badges.Count
        badges = $badges
    } | ConvertTo-Json -Depth 6 -Compress
}
finally {
    $image.Dispose()
}

