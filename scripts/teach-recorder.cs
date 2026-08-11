using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public static class AIWorkstationTeachRecorder
{
    private const int WH_MOUSE_LL = 14;
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP = 0x0205;
    private const int WM_MOUSEWHEEL = 0x020A;
    private const int WM_MOUSEMOVE = 0x0200;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const uint GA_ROOT = 2;

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public UIntPtr extraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public UIntPtr extraInfo; }

    public sealed class BoundsConfig { public int x; public int y; public int width; public int height; }
    public sealed class RecorderConfig
    {
        public long targetWindowHandle;
        public BoundsConfig allowedBounds;
        public string outputPath;
        public string livePath;
        public string readyPath;
        public string stopPath;
        public int maxDurationMs;
    }
    public sealed class RecordedEvent
    {
        public string type;
        public long atMs;
        public int x;
        public int y;
        public int toX;
        public int toY;
        public int delta;
        public int durationMs;
        public string button;
        public string key;
        public string text;
        public string automationId;
        public string name;
        public string controlType;
        public bool sensitive;
        public string source;
        public string[] modifiers;
    }
    public sealed class RecorderOutput
    {
        public int schemaVersion = 1;
        public string startedAt;
        public string stoppedAt;
        public long targetWindowHandle;
        public List<RecordedEvent> events;
        public List<string> warnings;
    }

    private sealed class PendingPointer { public POINT Point; public long AtMs; public string Button; public string[] Modifiers; }
    private sealed class RecordingContext : ApplicationContext
    {
        public readonly System.Windows.Forms.Timer Timer;
        public RecordingContext()
        {
            Timer = new System.Windows.Forms.Timer();
            Timer.Interval = 100;
            Timer.Tick += delegate { CheckStop(); };
            Timer.Start();
        }
    }

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static readonly object Sync = new object();
    private static readonly List<RecordedEvent> Events = new List<RecordedEvent>();
    private static readonly List<string> Warnings = new List<string>();
    private static readonly Stopwatch Clock = new Stopwatch();
    private static HookProc mouseProc;
    private static HookProc keyboardProc;
    private static IntPtr mouseHook = IntPtr.Zero;
    private static IntPtr keyboardHook = IntPtr.Zero;
    private static RecorderConfig config;
    private static IntPtr targetHandle;
    private static PendingPointer leftDown;
    private static PendingPointer rightDown;
    private static string startedAt;
    private static RecordingContext context;
    private static AutomationElement targetAutomation;
    private static AutomationPropertyChangedEventHandler valueChangedHandler;
    private static AutomationEventHandler invokedHandler;
    private static bool stopping;
    private static bool hasLastMove;
    private static POINT lastMove;
    private static long lastMoveAtMs;
    private static int lastLiveEventCount = -1;
    private static long lastKeyboardAtMs = -10000;

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("One Base64 configuration argument is required.");
            string json = Encoding.UTF8.GetString(Convert.FromBase64String(args[0]));
            config = new JavaScriptSerializer().Deserialize<RecorderConfig>(json);
            if (config == null || config.allowedBounds == null || config.targetWindowHandle <= 0) throw new ArgumentException("Recorder configuration is invalid.");
            targetHandle = new IntPtr(config.targetWindowHandle);
            startedAt = DateTime.UtcNow.ToString("o");
            Clock.Start();
            mouseProc = MouseHook;
            keyboardProc = KeyboardHook;
            IntPtr module = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
            keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
            if (mouseHook == IntPtr.Zero || keyboardHook == IntPtr.Zero) throw new InvalidOperationException("Could not install teaching hooks.");
            TrySubscribeValueChanges();
            Directory.CreateDirectory(Path.GetDirectoryName(config.outputPath));
            WriteSnapshot(config.livePath, false);
            File.WriteAllText(config.readyPath, DateTime.UtcNow.ToString("o"), new UTF8Encoding(false));
            context = new RecordingContext();
            Application.Run(context);
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                if (config != null && !String.IsNullOrEmpty(config.outputPath))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(config.outputPath));
                    File.WriteAllText(config.outputPath + ".error", error.ToString(), new UTF8Encoding(false));
                }
            }
            catch { }
            return 1;
        }
        finally { Cleanup(); }
    }

    private static void TrySubscribeValueChanges()
    {
        try
        {
            targetAutomation = AutomationElement.FromHandle(targetHandle);
            valueChangedHandler = OnAutomationValueChanged;
            invokedHandler = OnAutomationInvoked;
            Automation.AddAutomationPropertyChangedEventHandler(
                targetAutomation,
                TreeScope.Subtree,
                valueChangedHandler,
                ValuePattern.ValueProperty
            );
            Automation.AddAutomationEventHandler(
                InvokePattern.InvokedEvent,
                targetAutomation,
                TreeScope.Subtree,
                invokedHandler
            );
        }
        catch (Exception error)
        {
            lock (Sync) Warnings.Add("UI Automation value recording unavailable: " + error.Message);
        }
    }

    private static void OnAutomationValueChanged(object sender, AutomationPropertyChangedEventArgs args)
    {
        try
        {
            AutomationElement element = sender as AutomationElement;
            if (element == null || element.Current.ProcessId != targetAutomation.Current.ProcessId) return;
            long now = Clock.ElapsedMilliseconds;
            if (now - lastKeyboardAtMs > 1500) return;
            AutomationElement focused = AutomationElement.FocusedElement;
            if (focused == null || !Automation.Compare(element, focused)) return;
            ControlType controlType = element.Current.ControlType;
            if (controlType != ControlType.Edit && controlType != ControlType.Document && controlType != ControlType.ComboBox) return;
            System.Windows.Rect bounds = element.Current.BoundingRectangle;
            if (bounds.IsEmpty) return;
            bool sensitive = element.Current.IsPassword;
            RecordedEvent item = new RecordedEvent {
                type = "typeText",
                atMs = now,
                x = (int)Math.Round(bounds.X + bounds.Width / 2),
                y = (int)Math.Round(bounds.Y + bounds.Height / 2),
                text = sensitive ? null : Convert.ToString(args.NewValue),
                automationId = element.Current.AutomationId,
                name = element.Current.Name,
                controlType = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
                sensitive = sensitive
                ,source = "uia-event"
            };
            lock (Sync)
            {
                if (Events.Count > 0 && Events[Events.Count - 1].type == "typeText" &&
                    Events[Events.Count - 1].automationId == item.automationId &&
                    Events[Events.Count - 1].name == item.name)
                {
                    Events[Events.Count - 1] = item;
                }
                else Events.Add(item);
            }
        }
        catch { }
    }

    private static void OnAutomationInvoked(object sender, AutomationEventArgs args)
    {
        try
        {
            AutomationElement element = sender as AutomationElement;
            if (element == null || element.Current.ProcessId != targetAutomation.Current.ProcessId) return;
            System.Windows.Rect bounds = element.Current.BoundingRectangle;
            if (bounds.IsEmpty) return;
            AddEvent(new RecordedEvent {
                type = "click",
                atMs = Clock.ElapsedMilliseconds,
                x = (int)Math.Round(bounds.X + bounds.Width / 2),
                y = (int)Math.Round(bounds.Y + bounds.Height / 2),
                toX = (int)Math.Round(bounds.X + bounds.Width / 2),
                toY = (int)Math.Round(bounds.Y + bounds.Height / 2),
                button = "left",
                automationId = element.Current.AutomationId,
                name = element.Current.Name,
                controlType = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
                source = "uia-event"
            });
        }
        catch { }
    }

    private static IntPtr MouseHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && !stopping)
        {
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            int message = wParam.ToInt32();
            if (message == WM_MOUSEMOVE && PointBelongsToTarget(data.pt)) RecordPointerMove(data.pt);
            else if (message == WM_LBUTTONDOWN && PointBelongsToTarget(data.pt)) leftDown = NewPending(data.pt, "left", GetActiveModifiers());
            else if (message == WM_RBUTTONDOWN && PointBelongsToTarget(data.pt)) rightDown = NewPending(data.pt, "right", GetActiveModifiers());
            else if (message == WM_LBUTTONUP) CompletePointer(leftDown, data.pt);
            else if (message == WM_RBUTTONUP) CompletePointer(rightDown, data.pt);
            else if (message == WM_MOUSEWHEEL && PointBelongsToTarget(data.pt))
            {
                short delta = unchecked((short)((data.mouseData >> 16) & 0xffff));
                AddEvent(new RecordedEvent { type = "scroll", atMs = Clock.ElapsedMilliseconds, x = data.pt.X, y = data.pt.Y, delta = delta, source = "pointer-hook" });
            }
            if (message == WM_LBUTTONUP) leftDown = null;
            if (message == WM_RBUTTONUP) rightDown = null;
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    private static string[] GetActiveModifiers()
    {
        Keys modifiers = Control.ModifierKeys;
        var list = new System.Collections.Generic.List<string>();
        if ((modifiers & Keys.Control) == Keys.Control) list.Add("Control");
        if ((modifiers & Keys.Shift) == Keys.Shift) list.Add("Shift");
        if ((modifiers & Keys.Alt) == Keys.Alt) list.Add("Alt");
        return list.ToArray();
    }

    private static IntPtr KeyboardHook(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && !stopping && (wParam.ToInt32() == WM_KEYDOWN || wParam.ToInt32() == WM_SYSKEYDOWN) &&
            GetAncestor(GetForegroundWindow(), GA_ROOT) == targetHandle)
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            Keys key = (Keys)data.vkCode;
            string safeKey = SafeRecordedKey(key);
            string previewKey = SafePreviewKey(key);
            if (safeKey != null || previewKey != null)
            {
                lastKeyboardAtMs = Clock.ElapsedMilliseconds;
                RecordedEvent item = new RecordedEvent {
                    type = safeKey != null ? "pressKey" : "keyPreview",
                    atMs = Clock.ElapsedMilliseconds,
                    key = safeKey ?? previewKey,
                    source = "keyboard-hook"
                };
                try
                {
                    AutomationElement focused = AutomationElement.FocusedElement;
                    if (focused != null && targetAutomation != null && focused.Current.ProcessId == targetAutomation.Current.ProcessId)
                    {
                        System.Windows.Rect bounds = focused.Current.BoundingRectangle;
                        item.x = (int)Math.Round(bounds.X + bounds.Width / 2);
                        item.y = (int)Math.Round(bounds.Y + bounds.Height / 2);
                        item.automationId = focused.Current.AutomationId;
                        item.name = focused.Current.Name;
                        item.controlType = focused.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                        item.sensitive = (bool)focused.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, true);
                    }
                }
                catch { }
                if (!item.sensitive || safeKey != null) AddEvent(item);
            }
        }
        return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
    }

    private static string SafeNonTextKey(Keys key)
    {
        switch (key)
        {
            case Keys.Enter: return "Enter";
            case Keys.Tab: return "Tab";
            case Keys.Escape: return "Escape";
            case Keys.Back: return "Backspace";
            case Keys.Delete: return "Delete";
            case Keys.Left: return "ArrowLeft";
            case Keys.Right: return "ArrowRight";
            case Keys.Up: return "ArrowUp";
            case Keys.Down: return "ArrowDown";
            case Keys.Home: return "Home";
            case Keys.End: return "End";
            case Keys.PageUp: return "PageUp";
            case Keys.PageDown: return "PageDown";
            default: return null;
        }
    }

    private static string SafeRecordedKey(Keys key)
    {
        Keys modifiers = Control.ModifierKeys;
        if (modifiers == Keys.Control)
        {
            switch (key)
            {
                case Keys.Z: return "Ctrl+Z";
                case Keys.A: return "Ctrl+A";
            }
        }
        if (modifiers == Keys.None) return SafeNonTextKey(key);
        return null;
    }

    private static string SafePreviewKey(Keys key)
    {
        Keys modifiers = Control.ModifierKeys;
        if ((modifiers & Keys.Control) == Keys.Control && key >= Keys.A && key <= Keys.Z) return "Ctrl+" + key.ToString();
        if ((modifiers & Keys.Alt) == Keys.Alt && key >= Keys.A && key <= Keys.Z) return "Alt+" + key.ToString();
        if ((modifiers & Keys.Shift) == Keys.Shift && key >= Keys.A && key <= Keys.Z) return "Shift+" + key.ToString();
        if (key >= Keys.A && key <= Keys.Z) return key.ToString();
        if (key >= Keys.D0 && key <= Keys.D9) return key.ToString().Substring(1);
        if (key >= Keys.NumPad0 && key <= Keys.NumPad9) return "Num" + ((int)key - (int)Keys.NumPad0).ToString();
        if (key == Keys.Space) return "Space";
        return SafeNonTextKey(key);
    }

    private static void RecordPointerMove(POINT point)
    {
        long now = Clock.ElapsedMilliseconds;
        int dx = hasLastMove ? point.X - lastMove.X : 100;
        int dy = hasLastMove ? point.Y - lastMove.Y : 100;
        if (hasLastMove && now - lastMoveAtMs < 40) return;
        if (hasLastMove && dx * dx + dy * dy < 9) return;
        hasLastMove = true;
        lastMove = point;
        lastMoveAtMs = now;
        AddEvent(new RecordedEvent { type = "pointerMove", atMs = now, x = point.X, y = point.Y, source = "pointer-hook" });
    }

    private static PendingPointer NewPending(POINT point, string button, string[] modifiers)
    {
        return new PendingPointer { Point = point, AtMs = Clock.ElapsedMilliseconds, Button = button, Modifiers = modifiers };
    }

    private static void CompletePointer(PendingPointer pending, POINT end)
    {
        if (pending == null || !PointBelongsToTarget(end)) return;
        int dx = end.X - pending.Point.X;
        int dy = end.Y - pending.Point.Y;
        int duration = (int)Math.Min(Int32.MaxValue, Clock.ElapsedMilliseconds - pending.AtMs);
        bool drag = dx * dx + dy * dy > 36;
        AddEvent(new RecordedEvent {
            type = drag ? "drag" : "click",
            atMs = pending.AtMs,
            x = pending.Point.X,
            y = pending.Point.Y,
            toX = end.X,
            toY = end.Y,
            durationMs = duration,
            button = pending.Button,
            modifiers = drag && pending.Modifiers != null && pending.Modifiers.Length > 0 ? pending.Modifiers : null,
            source = "pointer-hook"
        });
    }

    private static bool PointBelongsToTarget(POINT point)
    {
        BoundsConfig b = config.allowedBounds;
        if (point.X < b.x || point.Y < b.y || point.X >= b.x + b.width || point.Y >= b.y + b.height) return false;
        IntPtr hit = WindowFromPoint(point);
        return hit != IntPtr.Zero && GetAncestor(hit, GA_ROOT) == targetHandle;
    }

    private static void AddEvent(RecordedEvent item)
    {
        lock (Sync) Events.Add(item);
    }

    private static void CheckStop()
    {
        if (stopping) return;
        WriteLiveSnapshot();
        if (File.Exists(config.stopPath) || Clock.ElapsedMilliseconds >= Math.Max(1000, config.maxDurationMs)) Stop();
    }

    private static void WriteLiveSnapshot()
    {
        int count;
        lock (Sync) count = Events.Count;
        if (count == lastLiveEventCount) return;
        WriteSnapshot(config.livePath, false);
        lastLiveEventCount = count;
    }

    private static void WriteSnapshot(string outputPath, bool stopped)
    {
        if (String.IsNullOrEmpty(outputPath)) return;
        RecorderOutput output = new RecorderOutput {
            startedAt = startedAt,
            stoppedAt = stopped ? DateTime.UtcNow.ToString("o") : null,
            targetWindowHandle = config.targetWindowHandle
        };
        lock (Sync)
        {
            output.events = new List<RecordedEvent>(Events);
            output.events.Sort(delegate(RecordedEvent a, RecordedEvent b) { return a.atMs.CompareTo(b.atMs); });
            output.warnings = new List<string>(Warnings);
        }
        File.WriteAllText(outputPath, new JavaScriptSerializer().Serialize(output), new UTF8Encoding(false));
    }

    private static void Stop()
    {
        stopping = true;
        WriteSnapshot(config.outputPath, true);
        context.ExitThread();
    }

    private static void Cleanup()
    {
        try
        {
            if (targetAutomation != null && valueChangedHandler != null)
                Automation.RemoveAutomationPropertyChangedEventHandler(targetAutomation, valueChangedHandler);
            if (targetAutomation != null && invokedHandler != null)
                Automation.RemoveAutomationEventHandler(InvokePattern.InvokedEvent, targetAutomation, invokedHandler);
        }
        catch { }
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        if (keyboardHook != IntPtr.Zero) UnhookWindowsHookEx(keyboardHook);
    }
}
