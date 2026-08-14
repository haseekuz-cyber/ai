[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigBase64)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$artifactDirectory = Join-Path $projectRoot 'artifacts\teach-recorder'
$outputPath = Join-Path $artifactDirectory 'AIWorkstationTeachRecorder.exe'
$sourcePath = Join-Path $PSScriptRoot 'teach-recorder.cs'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $outputPath) -or
    (Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc -gt (Get-Item -LiteralPath $outputPath).LastWriteTimeUtc) {
    if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Force }
    Add-Type -Path $sourcePath `
        -ReferencedAssemblies System.Drawing,System.Windows.Forms,System.Web.Extensions,UIAutomationClient,UIAutomationTypes,WindowsBase `
        -OutputAssembly $outputPath `
        -OutputType WindowsApplication
}

& $outputPath $ConfigBase64
exit $LASTEXITCODE
