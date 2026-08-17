[CmdletBinding()]
param(
    [switch]$NoBrowser
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
$logRoot = Join-Path $dataRoot 'Logs'
$stateRoot = Join-Path $dataRoot 'State'
$powershell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

New-Item -ItemType Directory -Path $logRoot, $stateRoot -Force | Out-Null

function Test-ListeningPort {
    param([Parameter(Mandatory)][int]$Port)
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-BackgroundComponent {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][int]$Port,
        [string[]]$ScriptArguments = @()
    )

    if (Test-ListeningPort -Port $Port) {
        return [ordered]@{ name = $Name; started = $false; alreadyRunning = $true; processId = $null }
    }

    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath) + $ScriptArguments
    $process = Start-Process -FilePath $powershell `
        -ArgumentList $arguments `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logRoot "$Name.stdout.log") `
        -RedirectStandardError (Join-Path $logRoot "$Name.stderr.log") `
        -PassThru

    return [ordered]@{ name = $Name; started = $true; alreadyRunning = $false; processId = $process.Id }
}

function Start-LmStudioServer {
    if (Test-ListeningPort -Port 1234) {
        return [ordered]@{ started = $false; alreadyRunning = $true; processId = $null }
    }

    $lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
    if (-not (Test-Path -LiteralPath $lms)) {
        return [ordered]@{ started = $false; alreadyRunning = $false; processId = $null; error = 'lms.exe was not found' }
    }

    $process = Start-Process -FilePath $lms `
        -ArgumentList @('server', 'start', '--port', '1234', '--bind', '127.0.0.1') `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logRoot 'lm-studio.stdout.log') `
        -RedirectStandardError (Join-Path $logRoot 'lm-studio.stderr.log') `
        -PassThru
    return [ordered]@{ started = $true; alreadyRunning = $false; processId = $process.Id }
}

function Ensure-LmStudioModel {
    $lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
    $model = if ($env:AI_WORKSTATION_LM_STUDIO_MODEL) { $env:AI_WORKSTATION_LM_STUDIO_MODEL } else { 'qwen/qwen3-vl-8b' }
    $modelKey = if ($env:AI_WORKSTATION_LM_STUDIO_MODEL_KEY) { $env:AI_WORKSTATION_LM_STUDIO_MODEL_KEY } else { $model }
    $contextLength = if ($env:AI_WORKSTATION_LM_STUDIO_CONTEXT_LENGTH) { $env:AI_WORKSTATION_LM_STUDIO_CONTEXT_LENGTH } else { '12288' }
    $gpuOffload = if ($env:AI_WORKSTATION_LM_STUDIO_GPU_OFFLOAD) { $env:AI_WORKSTATION_LM_STUDIO_GPU_OFFLOAD } else { 'max' }
    $parallel = if ($env:AI_WORKSTATION_LM_STUDIO_PARALLEL) { $env:AI_WORKSTATION_LM_STUDIO_PARALLEL } else { '1' }
    if (-not (Test-Path -LiteralPath $lms)) {
        return [ordered]@{ loaded = $false; alreadyLoaded = $false; model = $model; error = 'lms.exe was not found' }
    }
    try {
        # /v1/models is a catalog in recent LM Studio versions and may list an
        # unloaded model. `lms ps` is the authoritative loaded-instance check.
        # `lms ps` writes its normal "no models" message to stderr. With
        # ErrorActionPreference=Stop PowerShell used to abort here and skipped loading.
        try {
            $loadedModels = (& $lms ps 2>$null | Out-String)
        }
        catch {
            $loadedModels = ''
        }
        if ($loadedModels -match [regex]::Escape($model)) {
            return [ordered]@{ loaded = $true; alreadyLoaded = $true; model = $model; error = $null }
        }
        $loadArguments = @('load', $modelKey)
        if ($model -ne $modelKey) {
            $loadArguments += @('--identifier', $model)
        }
        $loadArguments += @('--gpu', $gpuOffload, '--context-length', $contextLength, '--parallel', $parallel, '-y')
        $loadStdout = Join-Path $logRoot 'lm-studio-model-load.log'
        $loadStderr = Join-Path $logRoot 'lm-studio-model-load.error.log'
        $loadProcess = Start-Process -FilePath $lms `
            -ArgumentList $loadArguments `
            -WindowStyle Hidden `
            -RedirectStandardOutput $loadStdout `
            -RedirectStandardError $loadStderr `
            -Wait `
            -PassThru
        if ($loadProcess.ExitCode -ne 0) {
            return [ordered]@{ loaded = $false; alreadyLoaded = $false; model = $model; error = "Model load exited with code $($loadProcess.ExitCode)" }
        }
        return [ordered]@{ loaded = $true; alreadyLoaded = $false; model = $model; error = $null }
    }
    catch {
        return [ordered]@{ loaded = $false; alreadyLoaded = $false; model = $model; error = $_.Exception.Message }
    }
}

function Wait-Endpoint {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [int]$TimeoutSeconds = 20
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return $true }
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }
    return $false
}

$secondaryScreens = @()
try {
    Add-Type -AssemblyName System.Windows.Forms
    $secondaryScreens = @([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary })
}
catch {}

$workerArguments = @('-EnableCapture')
if ($secondaryScreens.Count -eq 1) {
    $workerArguments += @('-DisplayDevice', $secondaryScreens[0].DeviceName)
}

$lmStudio = Start-LmStudioServer
$modelLoad = Ensure-LmStudioModel
$worker = Start-BackgroundComponent -Name 'worker' -ScriptPath (Join-Path $PSScriptRoot 'start-worker.ps1') -Port 47731 -ScriptArguments $workerArguments
$controller = Start-BackgroundComponent -Name 'controller' -ScriptPath (Join-Path $PSScriptRoot 'start-controller.ps1') -Port 47730

$launchState = [ordered]@{
    schemaVersion = 1
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    projectRoot = $projectRoot
    modelLoad = $modelLoad
    lmStudio = $lmStudio
    worker = $worker
    controller = $controller
}
$launchState | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stateRoot 'ai-workstation-launch.json') -Encoding UTF8

if (-not (Wait-Endpoint -Uri 'http://127.0.0.1:47730/api/status')) {
    throw "AI Workstation did not become ready. Check logs in $logRoot."
}

if (-not $NoBrowser) {
    Start-Process 'http://127.0.0.1:47730'
}

Write-Output 'AI Workstation is ready: http://127.0.0.1:47730'
