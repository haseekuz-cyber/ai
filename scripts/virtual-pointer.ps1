[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$StatePath,
    [int]$ParentProcessId = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public sealed class AiPointerForm : Form
{
    public string PointerLabel { get; set; }
    public string MessageText { get; set; }
    public string Tone { get; set; }

    public AiPointerForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        ClientSize = new Size(460, 160);
        DoubleBuffered = true;
        PointerLabel = "AI";
        MessageText = "";
        Tone = "working";
    }

    protected override bool ShowWithoutActivation
    {
        get { return true; }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
            cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            return cp;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;

        Point[] cursor = new[] {
            new Point(2, 2), new Point(2, 31), new Point(10, 23),
            new Point(16, 39), new Point(24, 35), new Point(17, 20),
            new Point(30, 20)
        };
        using (GraphicsPath path = new GraphicsPath())
        using (SolidBrush fill = new SolidBrush(Color.FromArgb(118, 99, 255)))
        using (Pen outline = new Pen(Color.White, 2f))
        using (SolidBrush badge = new SolidBrush(Color.FromArgb(24, 25, 35)))
        using (SolidBrush text = new SolidBrush(Color.White))
        using (Font font = new Font("Segoe UI", 9f, FontStyle.Bold))
        using (Font messageFont = new Font("Segoe UI", 9f, FontStyle.Regular))
        {
            path.AddPolygon(cursor);
            e.Graphics.FillPath(fill, path);
            e.Graphics.DrawPath(outline, path);
            e.Graphics.FillRoundedRectangle(badge, new Rectangle(30, 9, 42, 24), 8);
            e.Graphics.DrawString(PointerLabel, font, text, new PointF(37, 12));
            if (!String.IsNullOrWhiteSpace(MessageText))
            {
                Color toneColor = Tone == "success" ? Color.FromArgb(53, 187, 125)
                    : Tone == "error" ? Color.FromArgb(225, 83, 102)
                    : Tone == "warning" ? Color.FromArgb(225, 168, 65)
                    : Color.FromArgb(118, 99, 255);
                using (SolidBrush bubble = new SolidBrush(Color.FromArgb(238, 20, 23, 31)))
                using (Pen border = new Pen(toneColor, 1.5f))
                using (SolidBrush dot = new SolidBrush(toneColor))
                {
                    SizeF measured = e.Graphics.MeasureString(MessageText, messageFont, 376);
                    int messageHeight = Math.Min(90, Math.Max(36, (int)Math.Ceiling(measured.Height) + 4));
                    Rectangle bubbleBounds = new Rectangle(30, 42, 422, messageHeight + 18);
                    e.Graphics.FillRoundedRectangle(bubble, bubbleBounds, 10);
                    e.Graphics.DrawRoundedRectangle(border, bubbleBounds, 10);
                    e.Graphics.FillEllipse(dot, 42, 54, 8, 8);
                    RectangleF messageBounds = new RectangleF(58, 50, 376, messageHeight);
                    using (StringFormat format = new StringFormat())
                    {
                        format.Trimming = StringTrimming.EllipsisWord;
                        format.FormatFlags = StringFormatFlags.LineLimit;
                        e.Graphics.DrawString(MessageText, messageFont, text, messageBounds, format);
                    }
                }
            }
        }
    }
}

public static class GraphicsExtensions
{
    public static void FillRoundedRectangle(this Graphics graphics, Brush brush, Rectangle bounds, int radius)
    {
        int diameter = radius * 2;
        using (GraphicsPath path = new GraphicsPath())
        {
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            graphics.FillPath(brush, path);
        }
    }

    public static void DrawRoundedRectangle(this Graphics graphics, Pen pen, Rectangle bounds, int radius)
    {
        int diameter = radius * 2;
        using (GraphicsPath path = new GraphicsPath())
        {
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            graphics.DrawPath(pen, path);
        }
    }
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing

$resolvedStatePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($StatePath)
$form = [AiPointerForm]::new()
$form.Location = [System.Drawing.Point]::new(-500, -500)
$form.Opacity = 0.96

$lastWrite = [datetime]::MinValue
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
    if ($ParentProcessId -gt 0) {
        try { Get-Process -Id $ParentProcessId -ErrorAction Stop | Out-Null }
        catch {
            $timer.Stop()
            $form.Close()
            return
        }
    }

    if (-not (Test-Path -LiteralPath $resolvedStatePath)) { return }
    $writeTime = (Get-Item -LiteralPath $resolvedStatePath).LastWriteTimeUtc
    if ($writeTime -eq $lastWrite) { return }

    try {
        $state = Get-Content -LiteralPath $resolvedStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $form.Location = [System.Drawing.Point]::new([int]$state.x, [int]$state.y)
        $form.PointerLabel = if ($state.label) { [string]$state.label } else { 'AI' }
        $form.MessageText = if ($state.message) { [string]$state.message } else { '' }
        $form.Tone = if ($state.tone) { [string]$state.tone } else { 'working' }
        $form.Visible = ($state.visible -ne $false)
        $form.Invalidate()
        $script:lastWrite = $writeTime
    }
    catch {
        # The writer uses an atomic rename, but retain the last valid state if a read ever races.
    }
})

$form.Add_Shown({ $timer.Start() })
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[System.Windows.Forms.Application]::Run($form)
