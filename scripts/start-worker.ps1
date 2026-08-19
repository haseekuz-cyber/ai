[CmdletBinding()]
param(
    [int]$Port = 47731,
    [string]$DisplayDevice,
    [switch]$EnableCapture,
    # Autonomous UI mutations (ui.uia clicks/edits) are on by default so the
    # assistant can actually act. Pass -EnableMutations:$false to run observe-only.
    # NOTE: this only requests mutations; the benchmark gate must also pass
    # (a valid latest-report.json), otherwise policy still denies ui.uia.
    [bool]$EnableMutations = $true
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

$env:AI_WORKSTATION_WORKER_PORT = [string]$Port
if ($DisplayDevice) {
    $env:AI_WORKSTATION_DISPLAY = $DisplayDevice
}
if ($EnableCapture) {
    $env:AI_WORKSTATION_CAPTURE_ENABLED = '1'
}
# An explicit env value set by the caller always wins over the switch default.
if (-not $env:AI_WORKSTATION_AGENT_MUTATIONS) {
    $env:AI_WORKSTATION_AGENT_MUTATIONS = if ($EnableMutations) { '1' } else { '0' }
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
if (-not $env:AI_WORKSTATION_FEEDBACK_LOG) {
    $env:AI_WORKSTATION_FEEDBACK_LOG = Join-Path $dataRoot 'Learning\episodes.jsonl'
}
if (-not $env:AI_WORKSTATION_PRINCIPLES) {
    $env:AI_WORKSTATION_PRINCIPLES = Join-Path $dataRoot 'Learning\principles.json'
}
if (-not $env:AI_WORKSTATION_TEACHER_PROFILE) {
    $env:AI_WORKSTATION_TEACHER_PROFILE = Join-Path $dataRoot 'Learning\teacher-profile.json'
}
if (-not $env:AI_WORKSTATION_TEACHER_CHAT_LOG) {
    $env:AI_WORKSTATION_TEACHER_CHAT_LOG = Join-Path $dataRoot 'Learning\teacher-chat.jsonl'
}
if (-not $env:AI_WORKSTATION_TEACHER_EXPERIENCES) {
    $env:AI_WORKSTATION_TEACHER_EXPERIENCES = Join-Path $dataRoot 'Learning\teacher-experiences.jsonl'
}
if (-not $env:AI_WORKSTATION_TEACHER_MATERIALS) {
    $env:AI_WORKSTATION_TEACHER_MATERIALS = Join-Path $dataRoot 'Learning\teacher-materials.jsonl'
}
if (-not $env:AI_WORKSTATION_TEACHER_CHAT) {
    $env:AI_WORKSTATION_TEACHER_CHAT = Join-Path $dataRoot 'TeacherChat'
}
if (-not $env:AI_WORKSTATION_TEACHER_SANDBOX) {
    $env:AI_WORKSTATION_TEACHER_SANDBOX = Join-Path $dataRoot 'TeacherSandbox'
}
if (-not $env:AI_WORKSTATION_TEACHER_BACKUPS) {
    $env:AI_WORKSTATION_TEACHER_BACKUPS = Join-Path $dataRoot 'TeacherBackups'
}
if (-not $env:AI_WORKSTATION_ERROR_PACKETS) {
    $env:AI_WORKSTATION_ERROR_PACKETS = Join-Path $dataRoot 'SelfImprovement\Errors'
}
if (-not $env:AI_WORKSTATION_IMPROVEMENTS) {
    $env:AI_WORKSTATION_IMPROVEMENTS = Join-Path $dataRoot 'SelfImprovement\Candidates'
}
if (-not $env:AI_WORKSTATION_EVALUATIONS) {
    $env:AI_WORKSTATION_EVALUATIONS = Join-Path $dataRoot 'Evaluations'
}
if (-not $env:AI_WORKSTATION_SAFETY_STATE) {
    $env:AI_WORKSTATION_SAFETY_STATE = Join-Path $dataRoot 'State\safety.json'
}
if (-not $env:AI_WORKSTATION_SAFETY_HOTKEY_READY) {
    $env:AI_WORKSTATION_SAFETY_HOTKEY_READY = Join-Path $dataRoot 'State\safety-hotkey.ready'
}

& $node (Join-Path $projectRoot 'src\worker.mjs')
