[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigBase64)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public sealed class AiSafetyHotkeyForm : Form
{
    private const int WM_HOTKEY = 0x0312;
    private const int HotkeyId = 0xA11;
    private const uint ModControlShiftNoRepeat = 0x4006;
    private const uint VkF12 = 0x7B;
    private readonly string pauseUrl;
    private readonly string authToken;
    private readonly int parentProcessId;
    private readonly Timer parentTimer;
    public bool Registered { get; private set; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint virtualKey);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    public AiSafetyHotkeyForm(string pauseUrl, string authToken, int parentProcessId)
    {
        this.pauseUrl = pauseUrl;
        this.authToken = authToken;
        this.parentProcessId = parentProcessId;
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Minimized;
        parentTimer = new Timer();
        parentTimer.Interval = 1000;
        parentTimer.Tick += delegate
        {
            try { Process.GetProcessById(this.parentProcessId); }
            catch { Close(); }
        };
        parentTimer.Start();
    }

    protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        Registered = RegisterHotKey(Handle, HotkeyId, ModControlShiftNoRepeat, VkF12);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        if (Registered) UnregisterHotKey(Handle, HotkeyId);
        parentTimer.Stop();
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_HOTKEY && message.WParam.ToInt32() == HotkeyId)
        {
            try
            {
                using (var client = new WebClient())
                {
                    client.Encoding = Encoding.UTF8;
                    client.Headers[HttpRequestHeader.Authorization] = "Bearer " + authToken;
                    client.Headers[HttpRequestHeader.ContentType] = "application/json";
                    client.UploadString(pauseUrl, "POST", "{\"reason\":\"Emergency hotkey Ctrl+Shift+F12\"}");
                }
            }
            catch { }
        }
        base.WndProc(ref message);
    }
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing

$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64))
$config = $json | ConvertFrom-Json
$form = [AiSafetyHotkeyForm]::new([string]$config.pauseUrl, [string]$config.authToken, [int]$config.parentProcessId)
$null = $form.Handle
if (-not $form.Registered) { throw 'Could not register Ctrl+Shift+F12 as the emergency AI stop hotkey.' }
$readyDirectory = Split-Path -Parent ([string]$config.readyPath)
New-Item -ItemType Directory -Path $readyDirectory -Force | Out-Null
[IO.File]::WriteAllText([string]$config.readyPath, (Get-Date).ToUniversalTime().ToString('o'), [Text.UTF8Encoding]::new($false))
[Windows.Forms.Application]::Run($form)
