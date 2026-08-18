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
. (Join-Path $PSScriptRoot 'resolve-node.ps1')
$node = Resolve-NodeExecutable -ProjectRoot $projectRoot
. (Join-Path $PSScriptRoot 'model-defaults.ps1')
Set-DefaultLocalModel | Out-Null

$env:AI_WORKSTATION_CONTROLLER_PORT = [string]$Port
$env:AI_WORKSTATION_WORKER_PORT = [string]$WorkerPort
if (-not $env:AI_WORKSTATION_TOKEN) {
    $env:AI_WORKSTATION_TOKEN = 'development-local-only'
}

& $node (Join-Path $projectRoot 'src\controller.mjs')
