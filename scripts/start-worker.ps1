[CmdletBinding()]
param(
    [int]$Port = 47731,
    [string]$DisplayDevice,
    [switch]$EnableCapture
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

$env:AI_WORKSTATION_WORKER_PORT = [string]$Port
if ($DisplayDevice) {
    $env:AI_WORKSTATION_DISPLAY = $DisplayDevice
}
if ($EnableCapture) {
    $env:AI_WORKSTATION_CAPTURE_ENABLED = '1'
}
if (-not $env:AI_WORKSTATION_TOKEN) {
    $env:AI_WORKSTATION_TOKEN = 'development-local-only'
}
if (-not $env:AI_WORKSTATION_OBSERVATIONS) {
    $env:AI_WORKSTATION_OBSERVATIONS = Join-Path $dataRoot 'Screenshots'
}
if (-not $env:AI_WORKSTATION_POINTER_STATE) {
    $env:AI_WORKSTATION_POINTER_STATE = Join-Path $dataRoot 'State\virtual-pointer.json'
}
if (-not $env:AI_WORKSTATION_TEACHING) {
    $env:AI_WORKSTATION_TEACHING = Join-Path $dataRoot 'Teaching'
}
if (-not $env:AI_WORKSTATION_SKILLS) {
    $env:AI_WORKSTATION_SKILLS = Join-Path $dataRoot 'Skills'
}
if (-not $env:AI_WORKSTATION_AUDIT_LOG) {
    $env:AI_WORKSTATION_AUDIT_LOG = Join-Path $dataRoot 'Logs\actions.jsonl'
}
if (-not $env:AI_WORKSTATION_SAFETY_STATE) {
    $env:AI_WORKSTATION_SAFETY_STATE = Join-Path $dataRoot 'State\safety.json'
}
if (-not $env:AI_WORKSTATION_SAFETY_HOTKEY_READY) {
    $env:AI_WORKSTATION_SAFETY_HOTKEY_READY = Join-Path $dataRoot 'State\safety-hotkey.ready'
}

& $node (Join-Path $projectRoot 'src\worker.mjs')
