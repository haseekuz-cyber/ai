import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const powershell = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const overlayScript = fileURLToPath(new URL('../scripts/virtual-pointer.ps1', import.meta.url));

// The overlay's cursor arrow is filled with this colour, so finding it in a screen grab is
// proof that the agent's own overlay reaches the change detector.
const overlayPurple = { red: 118, green: 99, blue: 255 };
// scripts/virtual-pointer.ps1 gives the overlay form this client size, and the control window
// below copies it so both are measured over exactly the same area.
const overlaySize = { width: 460, height: 160 };

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

// Creating a Windows Forms window takes an unpredictable moment, so wait for the window to
// actually be on screen instead of assuming a fixed startup time. The budget is generous
// because every probe is a cold PowerShell that compiles C# with Add-Type: alone that costs
// about a second, but `node --test` runs test files in parallel and the same probe was measured
// at over 25 seconds under that load.
async function waitFor(probe, description, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(400);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

// Both measurements below grab whatever the screen shows at the window's rectangle, so they are
// only meaningful over a patch of desktop that no other application covers. A window spawned
// from a background process cannot take the foreground, and a topmost promotion is refused
// while a maximized window owns that monitor, so the place has to be chosen rather than fought
// for: with a browser maximized over the fixed position this file used to pick, the control
// window stayed underneath it and the run failed for a reason that had nothing to do with the
// product.
async function findFreeDesktopArea({ width, height }) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopAreaProbe
{
    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr window, StringBuilder text, int count);

    [StructLayout(LayoutKind.Sequential)]
    public struct Point { public int X; public int Y; }
}
'@

# Progman and WorkerW are the desktop itself; anything else at the point is a window that would
# be sampled instead of the one under test.
function Test-Free([int] $x, [int] $y) {
    $point = [DesktopAreaProbe+Point]::new()
    $point.X = $x
    $point.Y = $y
    $window = [DesktopAreaProbe]::WindowFromPoint($point)
    if ($window -eq [System.IntPtr]::Zero) { return $true }
    $root = [DesktopAreaProbe]::GetAncestor($window, 2)
    $name = [System.Text.StringBuilder]::new(256)
    [void][DesktopAreaProbe]::GetClassName($root, $name, 256)
    return @('Progman', 'WorkerW') -contains $name.ToString()
}

$areaWidth = ${width}
$areaHeight = ${height}
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $work = $screen.WorkingArea
    if (($work.Width - $areaWidth) -lt 80 -or ($work.Height - $areaHeight) -lt 80) { continue }
    foreach ($row in 0..2) {
        foreach ($column in 0..3) {
            $x = $work.X + 40 + [int](($work.Width - $areaWidth - 80) * $column / 3)
            $y = $work.Y + 40 + [int](($work.Height - $areaHeight - 80) * $row / 2)
            $free = $true
            foreach ($offsetX in @(2, [int]($areaWidth / 2), ($areaWidth - 3))) {
                foreach ($offsetY in @(2, [int]($areaHeight / 2), ($areaHeight - 3))) {
                    if (-not (Test-Free ($x + $offsetX) ($y + $offsetY))) { $free = $false }
                }
            }
            if ($free) {
                [Console]::Out.WriteLine((([ordered]@{ x = $x; y = $y }) | ConvertTo-Json -Compress))
                exit 0
            }
        }
    }
}
[Console]::Out.WriteLine('{}')
`;
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim());
  return Number.isFinite(parsed.x) && Number.isFinite(parsed.y) ? parsed : null;
}

// Resolved once and shared: probing the desktop is the same question for both measurements.
let freeAreaPromise;
function freeDesktopArea() {
  freeAreaPromise ??= findFreeDesktopArea(overlaySize);
  return freeAreaPromise;
}

const noFreeArea =
  'Every monitor is covered by another window, so a screen grab cannot measure any window here.';

// Grabs the window's own rectangle rather than a fixed screen region, and lifts the window
// above any other always-on-top application first, so the measurement does not depend on
// what else happens to be on the desktop.
async function measureWindowOfProcess(processId, { red, green, blue }, tolerance = 12) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OverlayCaptureProbe
{
    public delegate bool EnumProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter,
        int x, int y, int width, int height, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$found = [System.IntPtr]::Zero
$callback = [OverlayCaptureProbe+EnumProc]{
    param($window, $parameter)
    $owner = [uint32]0
    [void][OverlayCaptureProbe]::GetWindowThreadProcessId($window, [ref]$owner)
    if ($owner -eq ${processId} -and [OverlayCaptureProbe]::IsWindowVisible($window)) {
        $rectangle = [OverlayCaptureProbe+Rect]::new()
        [void][OverlayCaptureProbe]::GetWindowRect($window, [ref]$rectangle)
        if (($rectangle.Right - $rectangle.Left) -gt 0 -and ($rectangle.Bottom - $rectangle.Top) -gt 0) {
            $script:found = $window
            return $false
        }
    }
    return $true
}
[void][OverlayCaptureProbe]::EnumWindows($callback, [System.IntPtr]::Zero)
if ($found -eq [System.IntPtr]::Zero) {
    [Console]::Out.WriteLine('{"window":0}')
    exit 0
}

# HWND_TOPMOST with SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW: another always-on-top application
# must not be what the grab actually samples. Windows may refuse the promotion, which is why
# the measured area is chosen to be free desktop in the first place.
[void][OverlayCaptureProbe]::SetWindowPos($found, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0043)
Start-Sleep -Milliseconds 500

$rectangle = [OverlayCaptureProbe+Rect]::new()
[void][OverlayCaptureProbe]::GetWindowRect($found, [ref]$rectangle)
$width = $rectangle.Right - $rectangle.Left
$height = $rectangle.Bottom - $rectangle.Top
$bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($rectangle.Left, $rectangle.Top, 0, 0,
        [System.Drawing.Size]::new($width, $height), [System.Drawing.CopyPixelOperation]::SourceCopy)
    $matched = 0
    $sampled = 0
    for ($y = 0; $y -lt $height; $y += 2) {
        for ($x = 0; $x -lt $width; $x += 2) {
            $sampled++
            $color = $bitmap.GetPixel($x, $y)
            if ([math]::Abs([int]$color.R - ${red}) -le ${tolerance} -and
                [math]::Abs([int]$color.G - ${green}) -le ${tolerance} -and
                [math]::Abs([int]$color.B - ${blue}) -le ${tolerance}) { $matched++ }
        }
    }
    [Console]::Out.WriteLine((([ordered]@{
        window = [int64]$found
        width = $width
        height = $height
        sampled = $sampled
        matched = $matched
    }) | ConvertTo-Json -Compress))
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
`;
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
  ]);
  return JSON.parse(stdout.trim());
}

test('the overlay applies capture exclusion from inside its own process', async () => {
  const source = await fs.readFile(new URL('../scripts/virtual-pointer.ps1', import.meta.url), 'utf8');
  assert.match(source, /SetWindowDisplayAffinity\(IntPtr window, uint affinity\)/);
  assert.match(source, /WDA_EXCLUDEFROMCAPTURE = 0x00000011/);
  // Applied on handle creation, not once at startup: WinForms recreates the handle when
  // window styles change and the affinity is lost with it.
  assert.match(source, /protected override void OnHandleCreated[\s\S]*SetWindowDisplayAffinity\(Handle, WDA_EXCLUDEFROMCAPTURE\)/);
});

// Runs before the overlay measurement: without this control, "no overlay pixels" would also
// pass if the grab saw nothing at all.
test('the same measurement does see a topmost window that is not excluded', async (t) => {
  const area = await freeDesktopArea();
  if (!area) return t.skip(noFreeArea);

  const probeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workstation-probe-'));
  const probeScript = path.join(probeDirectory, 'topmost-probe.ps1');
  await fs.writeFile(probeScript, `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = [System.Windows.Forms.Form]::new()
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Location = [System.Drawing.Point]::new(${area.x}, ${area.y})
$form.ClientSize = [System.Drawing.Size]::new(${overlaySize.width}, ${overlaySize.height})
$form.BackColor = [System.Drawing.Color]::FromArgb(${overlayPurple.red}, ${overlayPurple.green}, ${overlayPurple.blue})
$form.Opacity = 0.96
$timer = [System.Windows.Forms.Timer]::new()
# Must outlive the wait budget above, otherwise the control window closes itself while the
# measurement is still retrying and the wait fails for the wrong reason.
$timer.Interval = 60000
$timer.Add_Tick({ $timer.Stop(); $form.Close() })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
`, 'utf8');

  const probe = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', probeScript
  ], { windowsHide: true, stdio: 'ignore' });

  t.after(async () => {
    probe.kill();
    await fs.rm(probeDirectory, { recursive: true, force: true });
  });

  const measured = await waitFor(
    async () => {
      const result = await measureWindowOfProcess(probe.pid, overlayPurple);
      return result.matched > 0 ? result : null;
    },
    'a topmost window without capture exclusion to appear in the grab'
  );
  assert.ok(measured.matched > 0,
    'A topmost window was invisible to the grab, so the overlay assertion proves nothing.');
});

test('a screen grab of the running overlay contains no overlay pixels', async (t) => {
  const area = await freeDesktopArea();
  if (!area) return t.skip(noFreeArea);

  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workstation-overlay-'));
  const statePath = path.join(stateDirectory, 'virtual-pointer.json');
  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    x: area.x,
    y: area.y,
    visible: true,
    label: 'AI',
    message: 'Change detector capture check',
    tone: 'working'
  }), 'utf8');

  const overlay = spawn(powershell, [
    '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', overlayScript,
    '-StatePath', statePath,
    '-ParentProcessId', String(process.pid)
  ], { windowsHide: true, stdio: 'ignore' });

  t.after(async () => {
    overlay.kill();
    await fs.rm(stateDirectory, { recursive: true, force: true });
  });

  const statusPath = path.join(stateDirectory, 'virtual-pointer-capture.json');
  const status = JSON.parse(await waitFor(
    () => fs.readFile(statusPath, 'utf8').catch(() => null),
    'the overlay window to report its capture status'
  ));
  assert.equal(status.excludedFromCapture, true,
    'The overlay could not exclude itself from screen capture on this machine.');

  // The overlay applies its position from a 100 ms polling timer.
  await delay(600);
  const measured = await measureWindowOfProcess(overlay.pid, overlayPurple);
  assert.ok(measured.window, 'The overlay window was never created.');
  assert.ok(measured.sampled > 0, 'The overlay window had no area to sample.');
  assert.equal(measured.matched, 0,
    `Found ${measured.matched} overlay pixels in the grab; the change detector would read them as application change.`);
});
