using System;
using System.Drawing;
using System.Windows.Forms;

public sealed class AIWorkstationPointerTestForm : Form
{
    private readonly Panel surface;
    private readonly Label status;
    private bool dragging;
    private int moveCount;

    protected override bool ShowWithoutActivation { get { return true; } }

    public AIWorkstationPointerTestForm()
    {
        Text = "AI Workstation Pointer Test";
        StartPosition = FormStartPosition.Manual;
        Location = new Point(2860, 220);
        Size = new Size(600, 360);
        TopMost = true;
        ShowInTaskbar = false;

        Label title = new Label {
            Text = "Safe drag and wheel test",
            Location = new Point(30, 18),
            AutoSize = true
        };
        status = new Label {
            Text = "Waiting",
            Location = new Point(30, 292),
            AutoSize = true
        };
        surface = new Panel {
            Name = "pointerSurface",
            Location = new Point(30, 50),
            Size = new Size(520, 220),
            BackColor = Color.LightSteelBlue,
            BorderStyle = BorderStyle.FixedSingle,
            TabStop = true
        };
        surface.MouseDown += OnSurfaceMouseDown;
        surface.MouseMove += OnSurfaceMouseMove;
        surface.MouseUp += OnSurfaceMouseUp;
        surface.MouseWheel += OnSurfaceMouseWheel;
        Controls.Add(title);
        Controls.Add(surface);
        Controls.Add(status);
    }

    private void OnSurfaceMouseDown(object sender, MouseEventArgs args)
    {
        dragging = true;
        moveCount = 0;
        status.Text = "Drag started";
    }

    private void OnSurfaceMouseMove(object sender, MouseEventArgs args)
    {
        if (!dragging) return;
        moveCount++;
        status.Text = "Moving " + moveCount + " at " + args.X + "," + args.Y;
    }

    private void OnSurfaceMouseUp(object sender, MouseEventArgs args)
    {
        if (!dragging) return;
        dragging = false;
        Text = moveCount > 0
            ? "AI Workstation Pointer Test - DRAG SUCCESS"
            : "AI Workstation Pointer Test - DRAG FAILED";
    }

    private void OnSurfaceMouseWheel(object sender, MouseEventArgs args)
    {
        Text = "AI Workstation Pointer Test - SCROLL SUCCESS";
        status.Text = "Wheel delta " + args.Delta;
    }

    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new AIWorkstationPointerTestForm());
    }
}
