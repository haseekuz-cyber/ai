[CmdletBinding()]
param(
    [int]$Port = 47730,
    [int]$WorkerPort = 47731
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = if ($env:AI_WORKSTATION_DATA_ROOT) {
    $env:AI_WORKSTATION_DATA_ROOT
}
elseif (Test-Path -LiteralPath 'D:\AI-Work\Agent-Data') {
    'D:\AI-Work\Agent-Data'
}
else {
    Join-Path $projectRoot 'artifacts'
}
$packagedNode = Join-Path $projectRoot 'runtime\node.exe'
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $packagedNode) {
    $node = $packagedNode
}
elseif ($nodeCommand) {
    $node = $nodeCommand.Source
}
elseif (Test-Path -LiteralPath $bundledNode) {
    $node = $bundledNode
}
else {
    throw 'Node.js 22 or newer is required for the proof-of-concept.'
}

$env:AI_WORKSTATION_CONTROLLER_PORT = [string]$Port
$env:AI_WORKSTATION_WORKER_PORT = [string]$WorkerPort
if (-not $env:AI_WORKSTATION_TOKEN) {
    $env:AI_WORKSTATION_TOKEN = 'development-local-only'
}

& $node (Join-Path $projectRoot 'src\controller.mjs')
