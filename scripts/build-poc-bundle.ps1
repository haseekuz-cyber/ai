[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $projectRoot 'dist\poc-bundle'
$runtimeRoot = Join-Path $bundleRoot 'runtime'
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if ($nodeCommand) {
    $node = $nodeCommand.Source
}
elseif (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
}
else {
    throw 'Node.js 22 or newer is required to build the proof-of-concept bundle.'
}

New-Item -ItemType Directory -Path $bundleRoot, $runtimeRoot -Force | Out-Null

foreach ($directory in @('src', 'public', 'docs')) {
    $destination = Join-Path $bundleRoot $directory
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -Path (Join-Path $projectRoot "$directory\*") -Destination $destination -Recurse -Force
}

$scriptsDestination = Join-Path $bundleRoot 'scripts'
New-Item -ItemType Directory -Path $scriptsDestination -Force | Out-Null
foreach ($script in @('diagnose.ps1', 'capture-display.ps1', 'capture-window.ps1', 'crop-image.ps1', 'detect-telegram-badges.ps1', 'window-message.ps1', 'check-lmstudio-vision.mjs', 'uia-bridge.ps1', 'virtual-pointer.ps1', 'uia-test-app.ps1', 'uia-test-app.cs', 'launcher.cs', 'build-launcher.ps1', 'start-all.ps1', 'start-controller.ps1', 'start-controller.cmd', 'start-worker.ps1', 'start-worker.cmd')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $scriptsDestination -Force
}

Copy-Item -LiteralPath $node -Destination (Join-Path $runtimeRoot 'node.exe') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $bundleRoot -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'Start AI Workstation.cmd') -Destination $bundleRoot -Force
& (Join-Path $PSScriptRoot 'build-launcher.ps1') `
    -SourcePath (Join-Path $PSScriptRoot 'launcher.cs') `
    -OutputPath (Join-Path $bundleRoot 'AI Workstation.exe') | Out-Null

$manifest = [ordered]@{
    schemaVersion = 1
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    nodeVersion = (& $node --version)
    purpose = 'Local same-session AI workplace with bounded window-local control'
}
$manifestJson = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $bundleRoot 'bundle-manifest.json'), $manifestJson, [System.Text.UTF8Encoding]::new($false))

Write-Output $bundleRoot
