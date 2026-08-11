[CmdletBinding()]
param(
    [string]$DeviceName = '\\.\DISPLAY1'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$testPath = Join-Path $projectRoot 'artifacts\capture-boundary-test.png'

$json = & (Join-Path $PSScriptRoot 'capture-display.ps1') -DeviceName $DeviceName -OutputPath $testPath
$metadata = $json | ConvertFrom-Json

Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($metadata.outputPath)
try {
    $imageWidth = $image.Width
    $imageHeight = $image.Height
}
finally {
    $image.Dispose()
}

if ($imageWidth -ne $metadata.bounds.width -or $imageHeight -ne $metadata.bounds.height) {
    throw 'Captured image dimensions escaped the assigned display boundary.'
}

$capturedPath = [string]$metadata.outputPath
$expectedPath = [System.IO.Path]::GetFullPath($testPath)
if ($capturedPath -ne $expectedPath) {
    throw 'Capture test output path did not match the exact disposable target.'
}

Remove-Item -LiteralPath $capturedPath -Force

[ordered]@{
    sessionId = $metadata.sessionId
    deviceName = $metadata.deviceName
    metadataWidth = $metadata.bounds.width
    metadataHeight = $metadata.bounds.height
    imageWidth = $imageWidth
    imageHeight = $imageHeight
    hashLength = $metadata.sha256.Length
    testImageDiscarded = -not (Test-Path -LiteralPath $capturedPath)
} | ConvertTo-Json -Compress

