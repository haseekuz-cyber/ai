[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$artifactDirectory = Join-Path $projectRoot 'artifacts\uia-test'
$outputPath = Join-Path $artifactDirectory 'AIWorkstationUiaTest.exe'
$sourcePath = Join-Path $PSScriptRoot 'uia-test-app.cs'

New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $outputPath) -or
    (Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc -gt (Get-Item -LiteralPath $outputPath).LastWriteTimeUtc) {
    if (Test-Path -LiteralPath $outputPath) {
        Remove-Item -LiteralPath $outputPath -Force
    }
    Add-Type -Path $sourcePath `
        -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml `
        -OutputAssembly $outputPath `
        -OutputType WindowsApplication
}

& $outputPath
