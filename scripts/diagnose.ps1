[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Get-OptionalFeatureState {
    param([Parameter(Mandatory)][string]$Name)

    try {
        $feature = Get-WindowsOptionalFeature -Online -FeatureName $Name
        return [string]$feature.State
    }
    catch {
        return 'Unavailable'
    }
}

function Get-TargetApplications {
    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    $installed = @(Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName } |
        Sort-Object DisplayName, DisplayVersion -Unique)

    $targets = [ordered]@{
        Photoshop = '^Adobe Photoshop(?:\s|$|\()'
        Telegram = '^Telegram Desktop$'
        Figma = '^Figma$'
        CorelDRAW = '^CorelDRAW Graphics Suite(?:\s\d{4})?$'
        Illustrator = '^Adobe Illustrator(?:\s|$)'
        AfterEffects = '^Adobe After Effects(?:\s|$)'
        Premiere = '^Adobe Premiere Pro(?:\s|$)'
        AutoCAD = '^(?:Autodesk )?AutoCAD LT 2025'
    }

    foreach ($target in $targets.GetEnumerator()) {
        $matches = @($installed | Where-Object { $_.DisplayName -match $target.Value })
        [ordered]@{
            product = [string]$target.Key
            detected = [bool]$matches.Count
            installations = @($matches | ForEach-Object {
                [ordered]@{
                    name = [string]$_.DisplayName
                    version = [string]$_.DisplayVersion
                    publisher = [string]$_.Publisher
                }
            })
        }
    }
}

function Get-PotentialConflicts {
    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    Get-ItemProperty $uninstallRoots -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match 'GeForce Experience|NVIDIA App|NVIDIA 3D Vision|VulkanRT|MSI Afterburner|RivaTuner|SoftXpand|BeTwin|WM Program' } |
        Sort-Object DisplayName -Unique |
        ForEach-Object {
            [ordered]@{
                name = [string]$_.DisplayName
                version = [string]$_.DisplayVersion
                publisher = [string]$_.Publisher
            }
        }
}

Add-Type -AssemblyName System.Windows.Forms

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
    [ordered]@{
        name = [string]$_.Name
        driverVersion = [string]$_.DriverVersion
        videoMode = [string]$_.VideoModeDescription
    }
})
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [ordered]@{
        deviceName = [string]$_.DeviceName
        primary = [bool]$_.Primary
        bounds = [ordered]@{
            x = [int]$_.Bounds.X
            y = [int]$_.Bounds.Y
            width = [int]$_.Bounds.Width
            height = [int]$_.Bounds.Height
        }
    }
})
$inputDevices = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
    Where-Object { $_.Class -in @('Keyboard', 'Mouse') } |
    ForEach-Object {
        [ordered]@{
            type = [string]$_.Class
            name = [string]$_.FriendlyName
            status = [string]$_.Status
            instanceId = [string]$_.InstanceId
        }
    })

$report = [ordered]@{
    schemaVersion = 1
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    session = [ordered]@{
        processId = $PID
        sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
        userName = [System.Environment]::UserName
        sessionName = [string]$env:SESSIONNAME
        interactive = [System.Environment]::UserInteractive
    }
    operatingSystem = [ordered]@{
        caption = [string]$os.Caption
        version = [string]$os.Version
        build = [string]$os.BuildNumber
        architecture = [string]$os.OSArchitecture
    }
    hardware = [ordered]@{
        manufacturer = [string]$computer.Manufacturer
        model = [string]$computer.Model
        ramGB = [math]::Round($computer.TotalPhysicalMemory / 1GB, 1)
        cpu = [ordered]@{
            name = [string]$cpu.Name
            cores = [int]$cpu.NumberOfCores
            logicalProcessors = [int]$cpu.NumberOfLogicalProcessors
            virtualizationFirmwareEnabled = [bool]$cpu.VirtualizationFirmwareEnabled
            vmMonitorModeExtensions = [bool]$cpu.VMMonitorModeExtensions
        }
        gpus = $gpus
        screens = $screens
        inputDevices = $inputDevices
    }
    windowsFeatures = [ordered]@{
        hyperV = Get-OptionalFeatureState -Name 'Microsoft-Hyper-V-All'
        windowsSandbox = Get-OptionalFeatureState -Name 'Containers-DisposableClientVM'
        virtualMachinePlatform = Get-OptionalFeatureState -Name 'VirtualMachinePlatform'
    }
    targetApplications = @(Get-TargetApplications)
    potentialConflicts = @(Get-PotentialConflicts)
    independentWorkplace = [ordered]@{
        sameWindowsSessionSupported = $true
        requiresSeparateAccount = $false
        activeDisplayCount = [int]$screens.Count
        hardwareReady = [bool]($screens.Count -ge 2)
        reason = if ($screens.Count -ge 2) {
            'A secondary display is available for bounded window-local AI control.'
        } else {
            'At least two active displays are required.'
        }
    }
}

$json = $report | ConvertTo-Json -Depth 8

if ($OutputPath) {
    $resolvedOutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
    $outputDirectory = Split-Path -Parent $resolvedOutputPath
    if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
    }
    [System.IO.File]::WriteAllText($resolvedOutputPath, $json, [System.Text.UTF8Encoding]::new($false))
}

$json
