using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class AiWorkstationLauncher
{
    [STAThread]
    private static void Main(string[] args)
    {
        const string appRoot = @"D:\AI-Apps\AI-Workstation";
        string script = Path.Combine(appRoot, "scripts", "start-all.ps1");
        if (!File.Exists(script))
        {
            MessageBox.Show(
                "AI Workstation не найден по адресу:\n" + script,
                "AI Workstation",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        bool noBrowser = Array.Exists(args, value => string.Equals(value, "--no-browser", StringComparison.OrdinalIgnoreCase));
        var start = new ProcessStartInfo
        {
            FileName = @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"" + (noBrowser ? " -NoBrowser" : string.Empty),
            WorkingDirectory = appRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        Process.Start(start);
    }
}
