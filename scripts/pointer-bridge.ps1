[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$RequestBase64)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AiPointerBridgeNative
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@

function Throw-BridgeError {
    param([string]$Code, [string]$Message)
    $exception = [InvalidOperationException]::new($Message)
    $exception.Data['BridgeCode'] = $Code
    throw $exception
}

function Get-CurrentUserActivity {
    $lastInput = [AiPointerBridgeNative+LASTINPUTINFO]::new()
    $lastInput.cbSize = [uint32][Runtime.InteropServices.Marshal]::SizeOf($lastInput)
    if (-not [AiPointerBridgeNative]::GetLastInputInfo([ref]$lastInput)) {
        Throw-BridgeError 'input_activity_unavailable' 'GetLastInputInfo failed.'
    }
    $cursor = [AiPointerBridgeNative+POINT]::new()
    if (-not [AiPointerBridgeNative]::GetCursorPos([ref]$cursor)) {
        Throw-BridgeError 'input_activity_unavailable' 'GetCursorPos failed.'
    }
    return [ordered]@{
        lastInputTick = [uint64]$lastInput.dwTime
        cursorX = [int]$cursor.X
        cursorY = [int]$cursor.Y
        focusedWindowHandle = [long][AiPointerBridgeNative]::GetForegroundWindow()
    }
}

function Assert-InputLease {
    param($Request, [string]$ActivityFailureCode)
    if ($null -eq $Request.executionSurface -or [string]$Request.executionSurface.mode -ne 'shared') { return }
    if ($null -eq $Request.inputLease) {
        Throw-BridgeError 'input_lease_required' 'A shared execution surface requires inputLease.'
    }
    if ([string]$Request.inputLease.surfaceId -ne [string]$Request.executionSurface.id) {
        Throw-BridgeError 'input_lease_wrong_surface' 'The input lease belongs to another execution surface.'
    }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($nowMs -gt [long]$Request.inputLease.expiresAtMs) {
        Throw-BridgeError 'input_lease_expired' 'The input lease expired before dispatch.'
    }
    $activity = Get-CurrentUserActivity
    $activityChanged =
        [uint64]$Request.inputLease.lastInputTick -ne [uint64]$activity.lastInputTick -or
        [int]$Request.inputLease.cursor.x -ne [int]$activity.cursorX -or
        [int]$Request.inputLease.cursor.y -ne [int]$activity.cursorY -or
        [long]$Request.inputLease.focusedWindowHandle -ne [long]$activity.focusedWindowHandle
    if ($activityChanged) {
        Throw-BridgeError $ActivityFailureCode 'User activity changed after the input lease was issued.'
    }
}

function Test-PointInside {
    param($Point, $Bounds)
    return $Point.x -ge $Bounds.x -and $Point.y -ge $Bounds.y -and
        $Point.x -lt ($Bounds.x + $Bounds.width) -and $Point.y -lt ($Bounds.y + $Bounds.height)
}

function Convert-ClientPoint {
    param([IntPtr]$Handle, $Point)
    $native = [AiPointerBridgeNative+POINT]::new()
    $native.X = [int]$Point.x
    $native.Y = [int]$Point.y
    if (-not [AiPointerBridgeNative]::ScreenToClient($Handle, [ref]$native)) { throw 'Could not convert the screen point.' }
    return $native
}

function Pack-Point {
    param($Point)
    $packed = (([int]$Point.Y -band 0xffff) -shl 16) -bor ([int]$Point.X -band 0xffff)
    return [IntPtr]::new($packed)
}

function Get-InputHandle {
    param([IntPtr]$TargetHandle, [uint32]$ExpectedProcessId, $Point)
    $screenPoint = [AiPointerBridgeNative+POINT]::new()
    $screenPoint.X = [int]$Point.x
    $screenPoint.Y = [int]$Point.y
    $hitHandle = [AiPointerBridgeNative]::WindowFromPoint($screenPoint)
    if ($hitHandle -eq [IntPtr]::Zero) { throw 'No visible window exists at the pointer point.' }
    $rootHandle = [AiPointerBridgeNative]::GetAncestor($hitHandle, 2)
    if ($rootHandle -ne $TargetHandle) {
        # Native applications commonly open dialogs as a second top-level
        # window owned by the same process. Treat that modal surface as part
        # of the selected application; a different process still fails
        # closed as a real obstruction.
        [uint32]$hitProcessId = 0
        [void][AiPointerBridgeNative]::GetWindowThreadProcessId($rootHandle, [ref]$hitProcessId)
        if ($hitProcessId -ne $ExpectedProcessId) {
            throw "The target window is obscured at the pointer point by process $hitProcessId."
        }
    }
    return $hitHandle
}

function Send-Click {
    param([IntPtr]$Handle, $Point, [string]$Button)
    $isRight = $Button -eq 'right'
    $downMessage = if ($isRight) { 0x0204 } else { 0x0201 }
    $upMessage = if ($isRight) { 0x0205 } else { 0x0202 }
    $downState = if ($isRight) { 2 } else { 1 }
    $packed = Pack-Point $Point
    [void][AiPointerBridgeNative]::PostMessage($Handle, 0x0200, [UIntPtr]::Zero, $packed)
    [void][AiPointerBridgeNative]::PostMessage($Handle, $downMessage, [UIntPtr]::new($downState), $packed)
    [void][AiPointerBridgeNative]::PostMessage($Handle, $upMessage, [UIntPtr]::Zero, $packed)
}

function Invoke-AccessiblePoint {
    param([uint32]$ExpectedProcessId, $Point)
    $screenPoint = [System.Windows.Point]::new([double]$Point.x, [double]$Point.y)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($screenPoint)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -lt 8 -and $null -ne $element; $depth++) {
        if ([uint32]$element.Current.ProcessId -ne $ExpectedProcessId) { return $null }
        $elementName = [string]$element.Current.Name
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
            ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
            return [ordered]@{ transport = 'uia-coordinate'; pattern = 'invoke'; element = $elementName }
        }
        if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
            ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
            return [ordered]@{ transport = 'uia-coordinate'; pattern = 'select'; element = $elementName }
        }
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
            ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
            return [ordered]@{ transport = 'uia-coordinate'; pattern = 'toggle'; element = $elementName }
        }
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
            $expand = [System.Windows.Automation.ExpandCollapsePattern]$pattern
            if ($expand.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $expand.Expand() } else { $expand.Collapse() }
            return [ordered]@{ transport = 'uia-coordinate'; pattern = 'expandCollapse'; element = $elementName }
        }
        $element = $walker.GetParent($element)
    }
    return $null
}

function Invoke-AccessibleScroll {
    param([uint32]$ExpectedProcessId, $Point, [int]$Delta)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint(
        [System.Windows.Point]::new([double]$Point.x, [double]$Point.y)
    )
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -lt 8 -and $null -ne $element; $depth++) {
        if ([uint32]$element.Current.ProcessId -ne $ExpectedProcessId) { return $null }
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
            $scroll = [System.Windows.Automation.ScrollPattern]$pattern
            if ($scroll.Current.VerticallyScrollable) {
                $amount = if ($Delta -gt 0) {
                    [System.Windows.Automation.ScrollAmount]::SmallDecrement
                } else {
                    [System.Windows.Automation.ScrollAmount]::SmallIncrement
                }
                $count = [math]::Max(1, [math]::Min(10, [math]::Ceiling([math]::Abs($Delta) / 120)))
                for ($index = 0; $index -lt $count; $index++) {
                    $scroll.Scroll([System.Windows.Automation.ScrollAmount]::NoAmount, $amount)
                }
                return [ordered]@{ transport = 'uia-coordinate'; pattern = 'scroll'; element = [string]$element.Current.Name }
            }
        }
        $element = $walker.GetParent($element)
    }
    return $null
}

function Set-AccessibleValue {
    param([uint32]$ExpectedProcessId, $Point, [string]$Text)
    $element = [System.Windows.Automation.AutomationElement]::FromPoint(
        [System.Windows.Point]::new([double]$Point.x, [double]$Point.y)
    )
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    for ($depth = 0; $depth -lt 8 -and $null -ne $element; $depth++) {
        if ([uint32]$element.Current.ProcessId -ne $ExpectedProcessId) { return $null }
        $pattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $value = [System.Windows.Automation.ValuePattern]$pattern
            if (-not $value.Current.IsReadOnly) {
                $value.SetValue($Text)
                return [ordered]@{ transport = 'uia-coordinate'; pattern = 'setValue'; element = [string]$element.Current.Name }
            }
        }
        $element = $walker.GetParent($element)
    }
    return $null
}

function Send-SafeKey {
    param([IntPtr]$Handle, [string]$Key)
    $virtualKeys = @{
        Enter = 0x0D; Tab = 0x09; Escape = 0x1B; Backspace = 0x08; Delete = 0x2E
        ArrowLeft = 0x25; ArrowUp = 0x26; ArrowRight = 0x27; ArrowDown = 0x28
        Home = 0x24; End = 0x23; PageUp = 0x21; PageDown = 0x22
    }
    $semanticMessages = @{ 'Ctrl+Z' = 0x0304 }
    if ($Key -eq 'Ctrl+A') {
        if (-not [AiPointerBridgeNative]::PostMessage($Handle, 0x00B1, [UIntPtr]::Zero, [IntPtr]::new(-1))) {
            throw 'Could not send select-all to the selected control.'
        }
        return 'semanticShortcut'
    }
    if ($semanticMessages.ContainsKey($Key)) {
        if (-not [AiPointerBridgeNative]::PostMessage($Handle, [uint32]$semanticMessages[$Key], [UIntPtr]::Zero, [IntPtr]::Zero)) {
            throw 'Could not send the semantic shortcut to the selected control.'
        }
        return 'semanticShortcut'
    }
    if (-not $virtualKeys.ContainsKey($Key)) { throw 'Only a safe window-local key or shortcut is allowed.' }
    $virtualKey = [uint64]$virtualKeys[$Key]
    if (-not [AiPointerBridgeNative]::PostMessage($Handle, 0x0100, [UIntPtr]::new($virtualKey), [IntPtr]::new(1))) { throw 'Could not post key-down to the selected window.' }
    if (-not [AiPointerBridgeNative]::PostMessage($Handle, 0x0101, [UIntPtr]::new($virtualKey), [IntPtr]::new([long]0xC0000001))) { throw 'Could not post key-up to the selected window.' }
}

try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))
    $request = $json | ConvertFrom-Json
    if ($request.confirmed -ne $true) { throw 'confirmed=true is required.' }
    Assert-InputLease $request 'user_activity_before_action'
    $handle = [IntPtr]::new([long]$request.windowHandle)
    if (-not [AiPointerBridgeNative]::IsWindow($handle)) { throw 'Target window no longer exists.' }

    [uint32]$processId = 0
    [void][AiPointerBridgeNative]::GetWindowThreadProcessId($handle, [ref]$processId)
    $process = Get-Process -Id $processId -ErrorAction Stop
    $forbidden = @($request.forbiddenProcessNames | ForEach-Object { ([string]$_).ToLowerInvariant().Replace('.exe', '') })
    if ($forbidden -contains $process.ProcessName.ToLowerInvariant()) { throw 'Target process is protected.' }

    [AiPointerBridgeNative+RECT]$windowRect = [AiPointerBridgeNative+RECT]::new()
    if (-not [AiPointerBridgeNative]::GetWindowRect($handle, [ref]$windowRect)) { throw 'Could not read target window bounds.' }
    $hasPoint = $null -ne $request.point
    $pointEntries = @()
    if ($request.action -eq 'drag') {
        $pointEntries += [pscustomobject]@{ label = 'from'; point = $request.from }
        $pointEntries += [pscustomobject]@{ label = 'to'; point = $request.to }
        if ($null -ne $request.trajectory) {
            $trajectoryIndex = 0
            foreach ($trajectoryPoint in @($request.trajectory)) {
                if ($null -ne $trajectoryPoint) {
                    $pointEntries += [pscustomobject]@{ label = "trajectory[$trajectoryIndex]"; point = $trajectoryPoint }
                }
                $trajectoryIndex++
            }
        }
    }
    elseif ($hasPoint) {
        $pointEntries += [pscustomobject]@{ label = 'point'; point = $request.point }
    }
    foreach ($entry in $pointEntries) {
        $point = $entry.point
        if ($null -eq $point) { throw "PowerShell pointer validation: $($entry.label) is missing." }
        if (-not (Test-PointInside $point $request.allowedBounds)) {
            throw "PowerShell pointer validation: $($entry.label) ($($point.x),$($point.y)) is outside the allowed action area on the AI display."
        }
        if ($point.x -lt $windowRect.Left -or $point.x -ge $windowRect.Right -or $point.y -lt $windowRect.Top -or $point.y -ge $windowRect.Bottom) {
            throw "PowerShell pointer validation: $($entry.label) ($($point.x),$($point.y)) is outside the target window."
        }
    }
    if ($request.action -eq 'pressKey' -and -not $hasPoint) {
        $windowCenter = [pscustomobject]@{
            x = [int][math]::Floor(($windowRect.Left + $windowRect.Right) / 2)
            y = [int][math]::Floor(($windowRect.Top + $windowRect.Bottom) / 2)
        }
        if (-not (Test-PointInside $windowCenter $request.allowedBounds)) { throw 'Target window is outside the AI display.' }
        $inputHandle = $handle
    }
    else {
        $inputPoint = if ($request.action -eq 'drag') { $request.from } else { $request.point }
        $inputHandle = Get-InputHandle $handle $processId $inputPoint
    }

    $cursorBefore = [Windows.Forms.Cursor]::Position
    $transport = $null
    Assert-InputLease $request 'user_activity_before_action'
    switch ([string]$request.action) {
        'click' {
            if ([string]$request.button -eq 'left') {
                $transport = Invoke-AccessiblePoint $processId $request.point
            }
            if ($null -eq $transport) {
                Send-Click $inputHandle (Convert-ClientPoint $inputHandle $request.point) ([string]$request.button)
                $transport = [ordered]@{ transport = 'window-message'; pattern = 'mouse'; element = $null }
            }
        }
        'doubleClick' {
            $point = Convert-ClientPoint $inputHandle $request.point
            Send-Click $inputHandle $point ([string]$request.button)
            Start-Sleep -Milliseconds 80
            Send-Click $inputHandle $point ([string]$request.button)
            $transport = [ordered]@{ transport = 'window-message'; pattern = 'doubleClick'; element = $null }
        }
        'scroll' {
            $transport = Invoke-AccessibleScroll $processId $request.point ([int]$request.delta)
            if ($null -eq $transport) {
                $delta = [int]$request.delta
                $wParamValue = ([long]($delta -band 0xffff) -shl 16)
                $screenPoint = [AiPointerBridgeNative+POINT]::new()
                $screenPoint.X = [int]$request.point.x
                $screenPoint.Y = [int]$request.point.y
                [void][AiPointerBridgeNative]::PostMessage($inputHandle, 0x020A, [UIntPtr]::new([uint64]$wParamValue), (Pack-Point $screenPoint))
                $transport = [ordered]@{ transport = 'window-message'; pattern = 'wheel'; element = $null }
            }
        }
        'drag' {
            $from = Convert-ClientPoint $inputHandle $request.from
            $to = Convert-ClientPoint $inputHandle $request.to
            $steps = [math]::Max(2, [math]::Min(120, [math]::Ceiling([int]$request.durationMs / 16)))
            $isRight = [string]$request.button -eq 'right'
            $downMessage = if ($isRight) { 0x0204 } else { 0x0201 }
            $upMessage = if ($isRight) { 0x0205 } else { 0x0202 }
            $buttonState = if ($isRight) { 2 } else { 1 }

            $modifierSpecs = @()
            [uint64]$modifierState = 0
            if ($null -ne $request.modifiers -and $request.modifiers.Count -gt 0) {
                foreach ($mod in $request.modifiers) {
                    switch ([string]$mod) {
                        'Control' {
                            $modifierSpecs += [pscustomobject]@{ Key = 0x11; Down = 0x0100; Up = 0x0101; DownParam = 1; UpParam = 0xC0000001 }
                            $modifierState = $modifierState -bor 0x0008
                        }
                        'Shift' {
                            $modifierSpecs += [pscustomobject]@{ Key = 0x10; Down = 0x0100; Up = 0x0101; DownParam = 1; UpParam = 0xC0000001 }
                            $modifierState = $modifierState -bor 0x0004
                        }
                        'Alt' {
                            $modifierSpecs += [pscustomobject]@{ Key = 0x12; Down = 0x0104; Up = 0x0105; DownParam = 0x20000001; UpParam = 0xE0000001 }
                        }
                        default { throw "Unknown modifier '$mod'. Only Control/Shift/Alt are allowed." }
                    }
                }
            }

            $pressedModifiers = @()
            $mouseDownSent = $false
            $lastPoint = $from
            $pathPoints = @()
            if ($null -ne $request.trajectory -and $request.trajectory.Count -gt 0) {
                foreach ($trajectoryPoint in $request.trajectory) {
                    $pathPoints += Convert-ClientPoint $inputHandle $trajectoryPoint
                }
                if ($pathPoints.Count -eq 0 -or $pathPoints[$pathPoints.Count - 1].X -ne $to.X -or $pathPoints[$pathPoints.Count - 1].Y -ne $to.Y) {
                    $pathPoints += $to
                }
            }
            else {
                for ($step = 1; $step -le $steps; $step++) {
                    $point = [AiPointerBridgeNative+POINT]::new()
                    $point.X = [int][math]::Round($from.X + (($to.X - $from.X) * $step / $steps))
                    $point.Y = [int][math]::Round($from.Y + (($to.Y - $from.Y) * $step / $steps))
                    $pathPoints += $point
                }
            }
            try {
                foreach ($modifier in $modifierSpecs) {
                    Assert-InputLease $request 'user_activity_during_action'
                    if (-not [AiPointerBridgeNative]::PostMessage(
                        $inputHandle,
                        [uint32]$modifier.Down,
                        [UIntPtr]::new([uint64]$modifier.Key),
                        [IntPtr]::new([long]$modifier.DownParam)
                    )) { throw 'Could not send modifier key-down to the selected window.' }
                    $pressedModifiers += $modifier
                }

                Assert-InputLease $request 'user_activity_during_action'
                if (-not [AiPointerBridgeNative]::PostMessage($inputHandle, 0x0200, [UIntPtr]::new($modifierState), (Pack-Point $from))) {
                    throw 'Could not move the window-local pointer to the drag start.'
                }
                Assert-InputLease $request 'user_activity_during_action'
                if (-not [AiPointerBridgeNative]::PostMessage(
                    $inputHandle,
                    $downMessage,
                    [UIntPtr]::new([uint64]($buttonState -bor $modifierState)),
                    (Pack-Point $from)
                )) { throw 'Could not send mouse-down for the drag.' }
                $mouseDownSent = $true

                $pathDelay = [math]::Max(1, [math]::Floor([int]$request.durationMs / [math]::Max(1, $pathPoints.Count)))
                foreach ($point in $pathPoints) {
                    Assert-InputLease $request 'user_activity_during_action'
                    if (-not [AiPointerBridgeNative]::PostMessage(
                        $inputHandle,
                        0x0200,
                        [UIntPtr]::new([uint64]($buttonState -bor $modifierState)),
                        (Pack-Point $point)
                    )) { throw 'Could not continue the drag trajectory.' }
                    $lastPoint = $point
                    Start-Sleep -Milliseconds $pathDelay
                }

                Assert-InputLease $request 'user_activity_during_action'
                if (-not [AiPointerBridgeNative]::PostMessage(
                    $inputHandle,
                    $upMessage,
                    [UIntPtr]::new($modifierState),
                    (Pack-Point $to)
                )) { throw 'Could not send mouse-up after the drag.' }
                $mouseDownSent = $false
                $transport = [ordered]@{ transport = 'window-message'; pattern = 'drag'; element = $null }
            }
            finally {
                if ($mouseDownSent) {
                    [void][AiPointerBridgeNative]::PostMessage(
                        $inputHandle,
                        $upMessage,
                        [UIntPtr]::new($modifierState),
                        (Pack-Point $lastPoint)
                    )
                }
                for ($i = $pressedModifiers.Count - 1; $i -ge 0; $i--) {
                    $modifier = $pressedModifiers[$i]
                    [void][AiPointerBridgeNative]::PostMessage(
                        $inputHandle,
                        [uint32]$modifier.Up,
                        [UIntPtr]::new([uint64]$modifier.Key),
                        [IntPtr]::new([long]$modifier.UpParam)
                    )
                }
            }
        }
        'typeText' {
            $transport = Set-AccessibleValue $processId $request.point ([string]$request.text)
            if ($null -eq $transport) {
                $fieldPoint = Convert-ClientPoint $inputHandle $request.point
                Assert-InputLease $request 'user_activity_during_action'
                Send-Click $inputHandle $fieldPoint 'left'
                Start-Sleep -Milliseconds 80
                if ([string]$request.textMode -ne 'insert') {
                    Assert-InputLease $request 'user_activity_during_action'
                    [void](Send-SafeKey $inputHandle 'Ctrl+A')
                }
                foreach ($character in ([string]$request.text).ToCharArray()) {
                    Assert-InputLease $request 'user_activity_during_action'
                    [void][AiPointerBridgeNative]::PostMessage($inputHandle, 0x0102, [UIntPtr]::new([uint64][int]$character), [IntPtr]::Zero)
                }
                $transport = [ordered]@{ transport = 'window-message'; pattern = 'focus-selectAll-char'; element = $null }
            }
        }
        'pressKey' {
            $keyPattern = Send-SafeKey $inputHandle ([string]$request.key)
            $transport = [ordered]@{ transport = 'window-message'; pattern = $(if ($keyPattern) { $keyPattern } else { 'safeKey' }); element = $null }
        }
        default { throw 'Unsupported pointer action.' }
    }
    Start-Sleep -Milliseconds 100
    $cursorAfter = [Windows.Forms.Cursor]::Position
    $response = [ordered]@{
        ok = $true
        action = [string]$request.action
        transport = $transport.transport
        pattern = $transport.pattern
        element = $transport.element
        windowHandle = [long]$handle
        inputWindowHandle = [long]$inputHandle
        processName = $process.ProcessName
        systemPointer = [ordered]@{
            usedByAction = $false
            changedDuringCall = ($cursorBefore.X -ne $cursorAfter.X -or $cursorBefore.Y -ne $cursorAfter.Y)
            before = [ordered]@{ x = $cursorBefore.X; y = $cursorBefore.Y }
            after = [ordered]@{ x = $cursorAfter.X; y = $cursorAfter.Y }
        }
    }
}
catch {
    $bridgeCode = if ($_.Exception.Data.Contains('BridgeCode')) { [string]$_.Exception.Data['BridgeCode'] } else { 'pointer_bridge_error' }
    $response = [ordered]@{ ok = $false; error = $bridgeCode; message = [string]$_.Exception.Message }
}

$response | ConvertTo-Json -Depth 8 -Compress
