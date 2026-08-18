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
const overlayPosition = { x: 200, y: 200 };

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

// Creating a Windows Forms window takes an unpredictable moment, so wait for the window to
// actually be on screen instead of assuming a fixed startup time.
async function waitFor(probe, description, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await delay(400);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

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
# must not be what the grab actually samples.
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

test('a screen grab of the running overlay contains no overlay pixels', async (t) => {
  const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-workstation-overlay-'));
  const statePath = path.join(stateDirectory, 'virtual-pointer.json');
  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    x: overlayPosition.x,
    y: overlayPosition.y,
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

test('the same measurement does see a topmost window that is not excluded', async (t) => {
  // Without this control, "no overlay pixels" would also pass if the grab saw nothing at all.
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
$form.Location = [System.Drawing.Point]::new(${overlayPosition.x}, ${overlayPosition.y})
$form.ClientSize = [System.Drawing.Size]::new(460, 160)
$form.BackColor = [System.Drawing.Color]::FromArgb(${overlayPurple.red}, ${overlayPurple.green}, ${overlayPurple.blue})
$form.Opacity = 0.96
$timer = [System.Windows.Forms.Timer]::new()
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
