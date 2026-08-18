# Shared Node.js runtime resolution for the launcher scripts.
#
# The launchers used to take the first candidate that merely existed, so a
# too-old `node` on PATH (for example an nvm-selected v18) was started silently
# and failed later inside the controller or worker. The required major version
# is read from package.json `engines.node` so the requirement has a single
# source of truth.

function Get-RequiredNodeMajor {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $packagePath = Join-Path $ProjectRoot 'package.json'
    if (-not (Test-Path -LiteralPath $packagePath)) { return 22 }

    try {
        $engines = (Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json).engines.node
    }
    catch {
        return 22
    }

    if ($engines -match '(\d+)') { return [int]$Matches[1] }
    return 22
}

function Get-NodeMajorVersion {
    param([Parameter(Mandatory)][string]$Path)

    # A candidate that is missing, not executable or not Node at all must be
    # skipped rather than abort the launcher, so failures collapse to 0.
    try {
        $raw = (& $Path --version | Out-String).Trim()
    }
    catch {
        return 0
    }

    if ($raw -match 'v?(\d+)\.') { return [int]$Matches[1] }
    return 0
}

function Resolve-NodeExecutable {
    param([Parameter(Mandatory)][string]$ProjectRoot)

    $required = Get-RequiredNodeMajor -ProjectRoot $ProjectRoot

    $candidates = @(Join-Path $ProjectRoot 'runtime\node.exe')
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    $candidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'

    $rejected = @()
    foreach ($candidate in $candidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $major = Get-NodeMajorVersion -Path $candidate
        if ($major -ge $required) { return $candidate }
        if ($major -gt 0) { $rejected += "$candidate (v$major)" }
    }

    $detail = if ($rejected.Count -gt 0) { " Rejected as too old: $($rejected -join '; ')." } else { '' }
    throw "Node.js $required or newer is required for the proof-of-concept.$detail"
}
