[CmdletBinding()]
param(
    [string]$SourcePath = (Join-Path $PSScriptRoot 'launcher.cs'),
    [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'AI Workstation.exe')
)

$ErrorActionPreference = 'Stop'
$resolvedSource = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourcePath)
$resolvedOutput = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

if (Test-Path -LiteralPath $resolvedOutput) {
    Remove-Item -LiteralPath $resolvedOutput -Force
}

Add-Type `
    -Path $resolvedSource `
    -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') `
    -OutputAssembly $resolvedOutput `
    -OutputType WindowsApplication

Get-Item -LiteralPath $resolvedOutput

