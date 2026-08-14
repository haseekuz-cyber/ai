[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RequestBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

function Convert-Bounds {
    param([Parameter(Mandatory)]$Rectangle)

    if ($Rectangle.IsEmpty) {
        return [ordered]@{ x = 0; y = 0; width = 0; height = 0; empty = $true }
    }

    return [ordered]@{
        x = [int][math]::Round($Rectangle.X)
        y = [int][math]::Round($Rectangle.Y)
        width = [int][math]::Round($Rectangle.Width)
        height = [int][math]::Round($Rectangle.Height)
        empty = $false
    }
}

function Get-ProcessNameSafe {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return '' }
    try {
        return [string](Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName
    }
    catch {
        return ''
    }
}

function Get-RuntimeId {
    param([Parameter(Mandatory)]$Element)

    try {
        return (@($Element.GetRuntimeId()) -join '.')
    }
    catch {
        return ''
    }
}

function Get-ControlTypeName {
    param([Parameter(Mandatory)]$Element)

    $programmaticName = [string]$Element.Current.ControlType.ProgrammaticName
    return $programmaticName.Replace('ControlType.', '')
}

function Get-PatternObject {
    param(
        [Parameter(Mandatory)]$Element,
        [Parameter(Mandatory)]$Pattern
    )

    $patternObject = $null
    if ($Element.TryGetCurrentPattern($Pattern, [ref]$patternObject)) {
        return $patternObject
    }
    return $null
}

function Get-ElementCapabilities {
    param([Parameter(Mandatory)]$Element)

    $capabilities = [System.Collections.Generic.List[string]]::new()
    $patterns = [ordered]@{
        invoke = [System.Windows.Automation.InvokePattern]::Pattern
        value = [System.Windows.Automation.ValuePattern]::Pattern
        toggle = [System.Windows.Automation.TogglePattern]::Pattern
        select = [System.Windows.Automation.SelectionItemPattern]::Pattern
        expandCollapse = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
    }

    foreach ($entry in $patterns.GetEnumerator()) {
        $patternObject = Get-PatternObject -Element $Element -Pattern $entry.Value
        if ($null -ne $patternObject) {
            $capabilities.Add([string]$entry.Key)
        }
    }

    return @($capabilities)
}

function Convert-Element {
    param(
        [Parameter(Mandatory)]$Element,
        [string]$ParentRuntimeId = ''
    )

    $current = $Element.Current
    $isPassword = [bool]$current.IsPassword
    $value = $null
    $valuePattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $valuePattern -and -not $isPassword) {
        $value = [string]$valuePattern.Current.Value
    }

    return [ordered]@{
        runtimeId = Get-RuntimeId -Element $Element
        parentRuntimeId = $ParentRuntimeId
        name = [string]$current.Name
        automationId = [string]$current.AutomationId
        className = [string]$current.ClassName
        controlType = Get-ControlTypeName -Element $Element
        processId = [int]$current.ProcessId
        processName = Get-ProcessNameSafe -ProcessId ([int]$current.ProcessId)
        nativeWindowHandle = [int]$current.NativeWindowHandle
        enabled = [bool]$current.IsEnabled
        offscreen = [bool]$current.IsOffscreen
        focusable = [bool]$current.IsKeyboardFocusable
        hasKeyboardFocus = [bool]$current.HasKeyboardFocus
        isPassword = $isPassword
        bounds = Convert-Bounds -Rectangle $current.BoundingRectangle
        value = $value
        capabilities = @(Get-ElementCapabilities -Element $Element)
    }
}

function Get-ControlType {
    param([Parameter(Mandatory)][string]$Name)

    switch ($Name.ToLowerInvariant()) {
        'button' { return [System.Windows.Automation.ControlType]::Button }
        'calendar' { return [System.Windows.Automation.ControlType]::Calendar }
        'checkbox' { return [System.Windows.Automation.ControlType]::CheckBox }
        'combobox' { return [System.Windows.Automation.ControlType]::ComboBox }
        'custom' { return [System.Windows.Automation.ControlType]::Custom }
        'datagrid' { return [System.Windows.Automation.ControlType]::DataGrid }
        'dataitem' { return [System.Windows.Automation.ControlType]::DataItem }
        'document' { return [System.Windows.Automation.ControlType]::Document }
        'edit' { return [System.Windows.Automation.ControlType]::Edit }
        'group' { return [System.Windows.Automation.ControlType]::Group }
        'header' { return [System.Windows.Automation.ControlType]::Header }
        'headeritem' { return [System.Windows.Automation.ControlType]::HeaderItem }
        'hyperlink' { return [System.Windows.Automation.ControlType]::Hyperlink }
        'image' { return [System.Windows.Automation.ControlType]::Image }
        'list' { return [System.Windows.Automation.ControlType]::List }
        'listitem' { return [System.Windows.Automation.ControlType]::ListItem }
        'menu' { return [System.Windows.Automation.ControlType]::Menu }
        'menubar' { return [System.Windows.Automation.ControlType]::MenuBar }
        'menuitem' { return [System.Windows.Automation.ControlType]::MenuItem }
        'pane' { return [System.Windows.Automation.ControlType]::Pane }
        'progressbar' { return [System.Windows.Automation.ControlType]::ProgressBar }
        'radiobutton' { return [System.Windows.Automation.ControlType]::RadioButton }
        'scrollbar' { return [System.Windows.Automation.ControlType]::ScrollBar }
        'separator' { return [System.Windows.Automation.ControlType]::Separator }
        'slider' { return [System.Windows.Automation.ControlType]::Slider }
        'spinner' { return [System.Windows.Automation.ControlType]::Spinner }
        'splitbutton' { return [System.Windows.Automation.ControlType]::SplitButton }
        'statusbar' { return [System.Windows.Automation.ControlType]::StatusBar }
        'tab' { return [System.Windows.Automation.ControlType]::Tab }
        'tabitem' { return [System.Windows.Automation.ControlType]::TabItem }
        'table' { return [System.Windows.Automation.ControlType]::Table }
        'text' { return [System.Windows.Automation.ControlType]::Text }
        'thumb' { return [System.Windows.Automation.ControlType]::Thumb }
        'titlebar' { return [System.Windows.Automation.ControlType]::TitleBar }
        'toolbar' { return [System.Windows.Automation.ControlType]::ToolBar }
        'tree' { return [System.Windows.Automation.ControlType]::Tree }
        'treeitem' { return [System.Windows.Automation.ControlType]::TreeItem }
        'window' { return [System.Windows.Automation.ControlType]::Window }
        default { throw "Unsupported control type: $Name" }
    }
}

function Test-BoundsCenter {
    param(
        [Parameter(Mandatory)]$Rectangle,
        $AllowedBounds
    )

    if ($null -eq $AllowedBounds) { return $true }
    if ($Rectangle.IsEmpty) { return $false }

    $centerX = $Rectangle.X + ($Rectangle.Width / 2)
    $centerY = $Rectangle.Y + ($Rectangle.Height / 2)
    return (
        $centerX -ge [double]$AllowedBounds.x -and
        $centerX -lt ([double]$AllowedBounds.x + [double]$AllowedBounds.width) -and
        $centerY -ge [double]$AllowedBounds.y -and
        $centerY -lt ([double]$AllowedBounds.y + [double]$AllowedBounds.height)
    )
}

function Get-WindowElement {
    param([Parameter(Mandatory)]$Request)

    if ([int64]$Request.windowHandle -le 0) {
        throw 'windowHandle must be a positive native window handle.'
    }

    $element = [System.Windows.Automation.AutomationElement]::FromHandle(
        [System.IntPtr]::new([int64]$Request.windowHandle)
    )
    if ($null -eq $element) {
        throw "Window $($Request.windowHandle) is not available. Refresh the window list."
    }
    if (-not (Test-BoundsCenter -Rectangle $element.Current.BoundingRectangle -AllowedBounds $Request.allowedBounds)) {
        throw 'The target window is outside the assigned AI display.'
    }
    return $element
}

function Find-TargetElement {
    param(
        [Parameter(Mandatory)]$Window,
        [Parameter(Mandatory)]$Selector
    )

    $all = $Window.FindAll(
        [System.Windows.Automation.TreeScope]::Subtree,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $matches = [System.Collections.Generic.List[object]]::new()

    foreach ($element in $all) {
        $current = $element.Current
        if ($Selector.runtimeId -and (Get-RuntimeId -Element $element) -ne [string]$Selector.runtimeId) { continue }
        if ($Selector.automationId -and [string]$current.AutomationId -ne [string]$Selector.automationId) { continue }
        if ($Selector.name -and [string]$current.Name -ne [string]$Selector.name) { continue }
        if ($Selector.nameContains -and -not ([string]$current.Name).Contains([string]$Selector.nameContains)) { continue }
        if ($Selector.className -and [string]$current.ClassName -ne [string]$Selector.className) { continue }
        if ($Selector.controlType -and $current.ControlType -ne (Get-ControlType -Name ([string]$Selector.controlType))) { continue }
        $matches.Add($element)
    }

    $ordinal = if ($null -ne $Selector.ordinal) { [int]$Selector.ordinal } else { 0 }
    if ($ordinal -lt 0 -or $ordinal -ge $matches.Count) {
        throw "Selector matched $($matches.Count) elements; ordinal $ordinal is unavailable."
    }
    return $matches[$ordinal]
}

function Assert-AllowedProcess {
    param(
        [Parameter(Mandatory)]$Window,
        $ForbiddenProcessNames
    )

    $processName = Get-ProcessNameSafe -ProcessId ([int]$Window.Current.ProcessId)
    foreach ($forbidden in @($ForbiddenProcessNames)) {
        if ($processName.Equals([string]$forbidden, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Process $processName is not an allowed UI Automation target."
        }
    }
}

function Invoke-ElementAction {
    param(
        [Parameter(Mandatory)]$Element,
        [Parameter(Mandatory)]$Request
    )

    if (-not $Element.Current.IsEnabled) {
        throw 'The target element is disabled.'
    }

    switch ([string]$Request.action) {
        'invoke' {
            $pattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -eq $pattern) { throw 'The target does not support InvokePattern.' }
            $pattern.Invoke()
        }
        'setValue' {
            $pattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -eq $pattern) { throw 'The target does not support ValuePattern.' }
            if ($pattern.Current.IsReadOnly) { throw 'The target value is read-only.' }
            $pattern.SetValue([string]$Request.value)
        }
        'toggle' {
            $pattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.TogglePattern]::Pattern)
            if ($null -eq $pattern) { throw 'The target does not support TogglePattern.' }
            $pattern.Toggle()
        }
        'select' {
            $pattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -eq $pattern) { throw 'The target does not support SelectionItemPattern.' }
            $pattern.Select()
        }
        'expand' {
            $pattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -eq $pattern) { throw 'The target does not support ExpandCollapsePattern.' }
            $pattern.Expand()
        }
        'collapse' {
            $pattern = Get-PatternObject -Element $Element -Pattern ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -eq $pattern) { throw 'The target does not support ExpandCollapsePattern.' }
            $pattern.Collapse()
        }
        default {
            throw "Unsupported non-invasive UI action: $($Request.action)"
        }
    }
}

function Get-WindowList {
    param([Parameter(Mandatory)]$Request)

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $result = [System.Collections.Generic.List[object]]::new()

    foreach ($window in $windows) {
        $current = $window.Current
        if ([int]$current.NativeWindowHandle -le 0) { continue }
        if ([int]$current.ProcessId -le 0) { continue }
        if ($current.IsOffscreen) { continue }
        if (-not (Test-BoundsCenter -Rectangle $current.BoundingRectangle -AllowedBounds $Request.allowedBounds)) { continue }
        $result.Add((Convert-Element -Element $window))
    }
    return @($result)
}

function Get-FocusedTopLevelWindow {
    param([Parameter(Mandatory)]$Request)

    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused) { throw 'No focused window is available for passive learning.' }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $current = $focused
    while ($null -ne $current) {
        $parent = $walker.GetParent($current)
        if ($null -eq $parent -or [System.Windows.Automation.Automation]::Compare($parent, $root)) { break }
        $current = $parent
    }
    if ([int]$current.Current.NativeWindowHandle -le 0) { throw 'The focused application has no recordable top-level window.' }
    if (-not (Test-BoundsCenter -Rectangle $current.Current.BoundingRectangle -AllowedBounds $Request.allowedBounds)) {
        throw 'The focused window is outside the observable desktop.'
    }
    return $current
}

function Get-ElementTree {
    param(
        [Parameter(Mandatory)]$Window,
        [Parameter(Mandatory)]$Request
    )

    $maxDepth = if ([int]$Request.maxDepth -gt 0) { [math]::Min([int]$Request.maxDepth, 8) } else { 4 }
    $maxElements = if ([int]$Request.maxElements -gt 0) { [math]::Min([int]$Request.maxElements, 1000) } else { 300 }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue([pscustomobject]@{ element = $Window; depth = 0; parentRuntimeId = '' })
    $result = [System.Collections.Generic.List[object]]::new()

    while ($queue.Count -gt 0 -and $result.Count -lt $maxElements) {
        $item = $queue.Dequeue()
        $snapshot = Convert-Element -Element $item.element -ParentRuntimeId $item.parentRuntimeId
        $snapshot.depth = [int]$item.depth
        $result.Add($snapshot)

        if ([int]$item.depth -ge $maxDepth) { continue }
        $child = $walker.GetFirstChild($item.element)
        while ($null -ne $child -and $result.Count + $queue.Count -lt $maxElements) {
            $queue.Enqueue([pscustomobject]@{
                element = $child
                depth = [int]$item.depth + 1
                parentRuntimeId = [string]$snapshot.runtimeId
            })
            $child = $walker.GetNextSibling($child)
        }
    }

    return [ordered]@{
        truncated = ($queue.Count -gt 0)
        count = $result.Count
        elements = @($result)
    }
}

try {
    $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($RequestBase64))
    $request = $json | ConvertFrom-Json

    switch ([string]$request.operation) {
        'listWindows' {
            $response = [ordered]@{ ok = $true; operation = 'listWindows'; windows = @(Get-WindowList -Request $request) }
        }
        'foregroundWindow' {
            $window = Get-FocusedTopLevelWindow -Request $request
            Assert-AllowedProcess -Window $window -ForbiddenProcessNames $request.forbiddenProcessNames
            $response = [ordered]@{ ok = $true; operation = 'foregroundWindow'; window = Convert-Element -Element $window }
        }
        'inspect' {
            $window = Get-WindowElement -Request $request
            Assert-AllowedProcess -Window $window -ForbiddenProcessNames $request.forbiddenProcessNames
            $tree = Get-ElementTree -Window $window -Request $request
            $response = [ordered]@{
                ok = $true
                operation = 'inspect'
                window = Convert-Element -Element $window
                truncated = $tree.truncated
                count = $tree.count
                elements = @($tree.elements)
            }
        }
        'action' {
            if ($request.confirmed -ne $true) {
                throw 'A non-invasive UI action requires confirmed=true.'
            }
            $window = Get-WindowElement -Request $request
            Assert-AllowedProcess -Window $window -ForbiddenProcessNames $request.forbiddenProcessNames
            $element = Find-TargetElement -Window $window -Selector $request.selector
            if (-not (Test-BoundsCenter -Rectangle $element.Current.BoundingRectangle -AllowedBounds $request.allowedBounds)) {
                throw 'The target element is outside the assigned AI display.'
            }
            $before = Convert-Element -Element $element
            $cursorBefore = [System.Windows.Forms.Cursor]::Position
            Invoke-ElementAction -Element $element -Request $request
            $cursorAfter = [System.Windows.Forms.Cursor]::Position
            Start-Sleep -Milliseconds 80
            $response = [ordered]@{
                ok = $true
                operation = 'action'
                action = [string]$request.action
                targetBefore = $before
                targetAfter = Convert-Element -Element $element
                systemPointer = [ordered]@{
                    usedByAction = $false
                    changedDuringCall = ($cursorBefore.X -ne $cursorAfter.X -or $cursorBefore.Y -ne $cursorAfter.Y)
                    before = [ordered]@{ x = $cursorBefore.X; y = $cursorBefore.Y }
                    after = [ordered]@{ x = $cursorAfter.X; y = $cursorAfter.Y }
                }
            }
        }
        default {
            throw "Unsupported UI Automation operation: $($request.operation)"
        }
    }
}
catch {
    $response = [ordered]@{
        ok = $false
        error = 'uia_bridge_error'
        message = [string]$_.Exception.Message
    }
}

$response | ConvertTo-Json -Depth 10 -Compress
