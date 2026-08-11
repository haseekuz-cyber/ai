using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Runtime.InteropServices;

public sealed class AIWorkstationUiaTestWindow : Window
{
    private readonly TextBox input;
    private readonly TextBlock status;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr windowHandle,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    public AIWorkstationUiaTestWindow()
    {
        Title = "AI Workstation UIA Test";
        Name = "uiaTestWindow";
        WindowStartupLocation = WindowStartupLocation.Manual;
        Left = 2260;
        Top = 240;
        Width = 536;
        Height = 390;
        ShowActivated = false;
        Topmost = true;
        SourceInitialized += HandleSourceInitialized;

        StackPanel panel = new StackPanel();
        panel.Margin = new Thickness(24);

        TextBlock title = new TextBlock();
        title.Text = "Safe test without moving the physical pointer";
        title.Margin = new Thickness(0, 0, 0, 18);

        input = new TextBox();
        input.Name = "testInput";
        input.Text = "Initial value";
        input.Width = 320;
        input.HorizontalAlignment = HorizontalAlignment.Left;
        input.Margin = new Thickness(0, 0, 0, 12);
        AutomationProperties.SetAutomationId(input, "testInput");
        AutomationProperties.SetName(input, "Test input");

        Button button = new Button();
        button.Name = "applyButton";
        button.Content = "Apply";
        button.Width = 130;
        button.HorizontalAlignment = HorizontalAlignment.Left;
        button.Margin = new Thickness(0, 0, 0, 18);
        button.Click += HandleApply;
        AutomationProperties.SetAutomationId(button, "applyButton");
        AutomationProperties.SetName(button, "Apply test");

        status = new TextBlock();
        status.Name = "statusLabel";
        status.Text = "Waiting for action";
        AutomationProperties.SetAutomationId(status, "statusLabel");
        AutomationProperties.SetName(status, "Test result");

        ScrollViewer scroll = new ScrollViewer();
        scroll.Name = "testScroll";
        scroll.Height = 90;
        scroll.Width = 320;
        scroll.HorizontalAlignment = HorizontalAlignment.Left;
        scroll.VerticalScrollBarVisibility = ScrollBarVisibility.Visible;
        scroll.Margin = new Thickness(0, 14, 0, 0);
        AutomationProperties.SetAutomationId(scroll, "testScroll");
        AutomationProperties.SetName(scroll, "Test scroll area");
        StackPanel scrollContent = new StackPanel();
        for (int index = 1; index <= 20; index++)
        {
            scrollContent.Children.Add(new TextBlock { Text = "Independent row " + index, Height = 22 });
        }
        scroll.Content = scrollContent;
        scroll.ScrollChanged += HandleScrollChanged;

        panel.Children.Add(title);
        panel.Children.Add(input);
        panel.Children.Add(button);
        panel.Children.Add(status);
        panel.Children.Add(scroll);
        Content = panel;
    }

    private void HandleSourceInitialized(object sender, EventArgs args)
    {
        IntPtr handle = new WindowInteropHelper(this).Handle;
        SetWindowPos(handle, IntPtr.Zero, 2260, 240, 536, 390, 0x0010 | 0x0004);
    }

    private void HandleApply(object sender, RoutedEventArgs args)
    {
        status.Text = "Success: " + input.Text;
        Title = "AI Workstation UIA Test - SUCCESS";
    }

    private void HandleScrollChanged(object sender, ScrollChangedEventArgs args)
    {
        if (args.VerticalOffset > 0)
        {
            Title = "AI Workstation UIA Test - SCROLL SUCCESS";
        }
    }

    [STAThread]
    public static void Main()
    {
        Application application = new Application();
        application.Run(new AIWorkstationUiaTestWindow());
    }
}
