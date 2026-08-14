using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
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
        public bool captureAllWindows;
        public BoundsConfig allowedBounds;
        public string outputPath;
        public string livePath;
        public string readyPath;
        public string stopPath;
        public string evidenceDirectory;
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
        public long sequence;
        public long windowHandle;
        public int processId;
        public string processName;
        public string windowName;
        public BoundsConfig windowBounds;
    }
    public sealed class RecordedFrame
    {
        public long throughSequence;
        public int logicalEventCount;
        public long atMs;
        public string imagePath;
        public string reason;
    }
    public sealed class RecorderOutput
    {
        public int schemaVersion = 1;
        public string startedAt;
        public string stoppedAt;
        public long targetWindowHandle;
        public List<RecordedEvent> events;
        public List<RecordedFrame> visualFrames;
        public List<string> warnings;
        public string stopReason;
    }

    private sealed class PendingPointer { public POINT Point; public long AtMs; public string Button; public string[] Modifiers; public IntPtr RootWindow; }
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
    private static readonly List<RecordedFrame> VisualFrames = new List<RecordedFrame>();
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
    private static bool hasLastPointerInteraction;
    private static POINT lastPointerInteraction;
    private static long lastPointerInteractionAtMs;
    private static long nextSequence;
    private static long lastCapturedSequence;
    private static bool evidenceWarningWritten;
    private static IntPtr lastObservedForegroundRoot;
    private static volatile bool hotkeyStopRequested;
    private static string stopReason = "controller";

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto)] private static extern IntPtr GetModuleHandle(string moduleName);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool GetKeyboardState(byte[] keyState);
    [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int ToUnicodeEx(
        uint virtualKey, uint scanCode, byte[] keyState, StringBuilder buffer,
        int bufferCapacity, uint flags, IntPtr keyboardLayout);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("One Base64 configuration argument is required.");
            string json = Encoding.UTF8.GetString(Convert.FromBase64String(args[0]));
            config = new JavaScriptSerializer().Deserialize<RecorderConfig>(json);
            if (config == null || config.allowedBounds == null || (!config.captureAllWindows && config.targetWindowHandle <= 0)) throw new ArgumentException("Recorder configuration is invalid.");
            targetHandle = new IntPtr(config.targetWindowHandle);
            startedAt = DateTime.UtcNow.ToString("o");
            Clock.Start();
            mouseProc = MouseHook;
            keyboardProc = KeyboardHook;
            IntPtr module = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, module, 0);
            keyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, keyboardProc, module, 0);
            if (mouseHook == IntPtr.Zero || keyboardHook == IntPtr.Zero) throw new InvalidOperationException("Could not install teaching hooks.");
            if (!config.captureAllWindows) TrySubscribeValueChanges();
            Directory.CreateDirectory(Path.GetDirectoryName(config.outputPath));
            lastObservedForegroundRoot = GetAncestor(GetForegroundWindow(), GA_ROOT);
            CaptureVisualEvidence(true, "initial");
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
                item.sequence = ++nextSequence;
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
            else if (message == WM_LBUTTONDOWN && PointBelongsToTarget(data.pt))
            {
                CaptureVisualEvidence(true, "before-pointer-action");
                leftDown = NewPending(data.pt, "left", GetActiveModifiers());
            }
            else if (message == WM_RBUTTONDOWN && PointBelongsToTarget(data.pt))
            {
                CaptureVisualEvidence(true, "before-pointer-action");
                rightDown = NewPending(data.pt, "right", GetActiveModifiers());
            }
            else if (message == WM_LBUTTONUP) CompletePointer(leftDown, data.pt);
            else if (message == WM_RBUTTONUP) CompletePointer(rightDown, data.pt);
            else if (message == WM_MOUSEWHEEL && PointBelongsToTarget(data.pt))
            {
                CaptureVisualEvidence(true, "before-scroll");
                short delta = unchecked((short)((data.mouseData >> 16) & 0xffff));
                RecordedEvent item = new RecordedEvent { type = "scroll", atMs = Clock.ElapsedMilliseconds, x = data.pt.X, y = data.pt.Y, delta = delta, source = "pointer-hook" };
                PopulatePointerTarget(item, data.pt);
                AddEvent(item);
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
        IntPtr foregroundRoot = GetAncestor(GetForegroundWindow(), GA_ROOT);
        if (nCode >= 0 && !stopping && (wParam.ToInt32() == WM_KEYDOWN || wParam.ToInt32() == WM_SYSKEYDOWN) &&
            WindowBelongsToScope(foregroundRoot))
        {
            KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            Keys key = (Keys)data.vkCode;
            Keys activeModifiers = Control.ModifierKeys;
            if (key == Keys.F10 && (activeModifiers & Keys.Control) == Keys.Control && (activeModifiers & Keys.Alt) == Keys.Alt)
            {
                hotkeyStopRequested = true;
                return new IntPtr(1);
            }
            string safeKey = SafeRecordedKey(key);
            string previewKey = SafePreviewKey(key);
            string typedText = safeKey == null ? TranslateKeyToText(data) : null;
            if (safeKey != null || previewKey != null || typedText != null)
            {
                if (safeKey != null) CaptureVisualEvidence(true, "before-key-action");
                lastKeyboardAtMs = Clock.ElapsedMilliseconds;
                RecordedEvent item = new RecordedEvent {
                    type = safeKey != null ? "pressKey" : (typedText != null ? "typeText" : "keyPreview"),
                    atMs = Clock.ElapsedMilliseconds,
                    key = safeKey ?? previewKey,
                    text = typedText,
                    source = "keyboard-hook"
                };
                PopulateWindowContext(item, foregroundRoot);
                try
                {
                    AutomationElement focused = AutomationElement.FocusedElement;
                    if (focused != null && (config.captureAllWindows ||
                        (targetAutomation != null && focused.Current.ProcessId == targetAutomation.Current.ProcessId)))
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
                if (item.type == "typeText" && hasLastPointerInteraction &&
                    item.atMs - lastPointerInteractionAtMs <= 15000 &&
                    item.controlType != "Edit" && item.controlType != "Document" && item.controlType != "ComboBox")
                {
                    item.x = lastPointerInteraction.X;
                    item.y = lastPointerInteraction.Y;
                }
                if (!item.sensitive || safeKey != null) AddEvent(item);
            }
        }
        return CallNextHookEx(keyboardHook, nCode, wParam, lParam);
    }

    private static string TranslateKeyToText(KBDLLHOOKSTRUCT data)
    {
        try
        {
            Keys modifiers = Control.ModifierKeys;
            bool control = (modifiers & Keys.Control) == Keys.Control;
            bool alt = (modifiers & Keys.Alt) == Keys.Alt;
            // Plain Ctrl or Alt is a shortcut. Ctrl+Alt may be AltGr and can produce text.
            if (control != alt) return null;
            byte[] state = new byte[256];
            if (!GetKeyboardState(state)) return null;
            uint processId;
            uint threadId = GetWindowThreadProcessId(GetForegroundWindow(), out processId);
            StringBuilder buffer = new StringBuilder(8);
            int count = ToUnicodeEx(data.vkCode, data.scanCode, state, buffer, buffer.Capacity, 0, GetKeyboardLayout(threadId));
            if (count <= 0) return null;
            string value = buffer.ToString(0, Math.Min(count, buffer.Length));
            return String.IsNullOrEmpty(value) || Char.IsControl(value[0]) ? null : value;
        }
        catch { return null; }
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
        return new PendingPointer {
            Point = point,
            AtMs = Clock.ElapsedMilliseconds,
            Button = button,
            Modifiers = modifiers,
            RootWindow = GetAncestor(WindowFromPoint(point), GA_ROOT)
        };
    }

    private static void CompletePointer(PendingPointer pending, POINT end)
    {
        if (pending == null || !PointBelongsToTarget(end)) return;
        hasLastPointerInteraction = true;
        lastPointerInteraction = end;
        lastPointerInteractionAtMs = Clock.ElapsedMilliseconds;
        int dx = end.X - pending.Point.X;
        int dy = end.Y - pending.Point.Y;
        int duration = (int)Math.Min(Int32.MaxValue, Clock.ElapsedMilliseconds - pending.AtMs);
        bool drag = dx * dx + dy * dy > 36;
        RecordedEvent item = new RecordedEvent {
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
        };
        PopulateWindowContext(item, pending.RootWindow);
        PopulateAutomationTarget(item, pending.Point);
        AddEvent(item);
    }

    private static bool PointInsideAllowedBounds(POINT point)
    {
        BoundsConfig b = config.allowedBounds;
        return point.X >= b.x && point.Y >= b.y && point.X < b.x + b.width && point.Y < b.y + b.height;
    }

    private static bool WindowBelongsToScope(IntPtr root)
    {
        if (root == IntPtr.Zero) return false;
        if (!config.captureAllWindows) return root == targetHandle;
        RECT rect;
        if (!GetWindowRect(root, out rect)) return false;
        BoundsConfig b = config.allowedBounds;
        return rect.Right > b.x && rect.Bottom > b.y && rect.Left < b.x + b.width && rect.Top < b.y + b.height;
    }

    private static bool PointBelongsToTarget(POINT point)
    {
        if (!PointInsideAllowedBounds(point)) return false;
        IntPtr hit = WindowFromPoint(point);
        return hit != IntPtr.Zero && WindowBelongsToScope(GetAncestor(hit, GA_ROOT));
    }

    private static void PopulatePointerTarget(RecordedEvent item, POINT point)
    {
        IntPtr root = GetAncestor(WindowFromPoint(point), GA_ROOT);
        PopulateWindowContext(item, root);
        PopulateAutomationTarget(item, point);
    }

    private static void PopulateAutomationTarget(RecordedEvent item, POINT point)
    {
        try
        {
            AutomationElement element = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
            if (element == null) return;
            item.automationId = element.Current.AutomationId;
            item.name = element.Current.Name;
            item.controlType = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
            item.sensitive = element.Current.IsPassword;
        }
        catch { }
    }

    private static void PopulateWindowContext(RecordedEvent item, IntPtr root)
    {
        if (item == null || root == IntPtr.Zero) return;
        item.windowHandle = root.ToInt64();
        uint processId;
        GetWindowThreadProcessId(root, out processId);
        item.processId = unchecked((int)processId);
        try { item.processName = Process.GetProcessById(item.processId).ProcessName; } catch { }
        try
        {
            StringBuilder title = new StringBuilder(1024);
            GetWindowText(root, title, title.Capacity);
            item.windowName = title.ToString();
        }
        catch { }
        RECT rect;
        if (GetWindowRect(root, out rect))
        {
            item.windowBounds = new BoundsConfig {
                x = rect.Left,
                y = rect.Top,
                width = Math.Max(0, rect.Right - rect.Left),
                height = Math.Max(0, rect.Bottom - rect.Top)
            };
        }
    }

    private static void AddEvent(RecordedEvent item)
    {
        lock (Sync)
        {
            if (item != null && item.type == "typeText" && item.source == "keyboard-hook" &&
                !String.IsNullOrEmpty(item.text))
            {
                for (int index = Events.Count - 1; index >= 0; index--)
                {
                    RecordedEvent previous = Events[index];
                    if (previous.type == "pointerMove" || previous.type == "keyPreview") continue;
                    if (previous.type == "typeText" && previous.source == "keyboard-hook" &&
                        previous.automationId == item.automationId && previous.name == item.name &&
                        item.atMs - previous.atMs <= 1500)
                    {
                        previous.text = (previous.text ?? String.Empty) + item.text;
                        previous.atMs = item.atMs;
                        previous.sequence = ++nextSequence;
                        return;
                    }
                    break;
                }
            }
            item.sequence = ++nextSequence;
            Events.Add(item);
        }
    }

    private static bool IsLogicalEvidenceEvent(RecordedEvent item)
    {
        return item != null && item.type != "pointerMove" && item.type != "keyPreview";
    }

    private static void CaptureVisualEvidence(bool force, string reason = "after-action")
    {
        if (String.IsNullOrEmpty(config.evidenceDirectory)) return;
        long throughSequence = 0;
        long latestAtMs = 0;
        int logicalCount = 0;
        lock (Sync)
        {
            foreach (RecordedEvent item in Events)
            {
                if (!IsLogicalEvidenceEvent(item)) continue;
                logicalCount++;
                if (item.sequence > throughSequence) throughSequence = item.sequence;
                if (item.atMs > latestAtMs) latestAtMs = item.atMs;
            }
        }
        if (!force && throughSequence <= lastCapturedSequence) return;
        if (!force && Clock.ElapsedMilliseconds - latestAtMs < 120) return;
        try
        {
            RECT rect;
            if (config.captureAllWindows)
            {
                rect = new RECT {
                    Left = config.allowedBounds.x,
                    Top = config.allowedBounds.y,
                    Right = config.allowedBounds.x + config.allowedBounds.width,
                    Bottom = config.allowedBounds.y + config.allowedBounds.height
                };
            }
            else if (!GetWindowRect(targetHandle, out rect)) throw new InvalidOperationException("Could not read target window bounds.");
            int width = rect.Right - rect.Left;
            int height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0) throw new InvalidOperationException("Target window bounds are empty.");
            Directory.CreateDirectory(config.evidenceDirectory);
            string imagePath = Path.Combine(config.evidenceDirectory, String.Format("step-frame-{0:D6}-{1:D6}.png", throughSequence, Clock.ElapsedMilliseconds));
            using (Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                bitmap.Save(imagePath, ImageFormat.Png);
            }
            lock (Sync)
            {
                if (VisualFrames.Count >= 256)
                {
                    // Keep the early context and a sliding recent history. The
                    // previous implementation stopped capturing forever at
                    // frame 256, so a long demonstration had no final result.
                    RecordedFrame replaced = VisualFrames[128];
                    VisualFrames.RemoveAt(128);
                    try { if (File.Exists(replaced.imagePath)) File.Delete(replaced.imagePath); } catch { }
                }
                VisualFrames.Add(new RecordedFrame {
                    throughSequence = throughSequence,
                    logicalEventCount = logicalCount,
                    atMs = Clock.ElapsedMilliseconds,
                    imagePath = imagePath,
                    reason = reason
                });
            }
            lastCapturedSequence = throughSequence;
        }
        catch (Exception error)
        {
            if (!evidenceWarningWritten)
            {
                lock (Sync) Warnings.Add("Per-step visual evidence unavailable: " + error.Message);
                evidenceWarningWritten = true;
            }
        }
    }

    private static void CheckStop()
    {
        if (stopping) return;
        if (config.captureAllWindows)
        {
            IntPtr foregroundRoot = GetAncestor(GetForegroundWindow(), GA_ROOT);
            if (foregroundRoot != IntPtr.Zero && foregroundRoot != lastObservedForegroundRoot)
            {
                lastObservedForegroundRoot = foregroundRoot;
                CaptureVisualEvidence(true, "window-change");
            }
        }
        CaptureVisualEvidence(false, "after-action");
        WriteLiveSnapshot();
        if (hotkeyStopRequested) Stop("hotkey");
        else if (File.Exists(config.stopPath)) Stop("controller");
        else if (Clock.ElapsedMilliseconds >= Math.Max(1000, config.maxDurationMs)) Stop("timeout");
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
            ,stopReason = stopped ? stopReason : null
        };
        lock (Sync)
        {
            output.events = new List<RecordedEvent>(Events);
            output.events.Sort(delegate(RecordedEvent a, RecordedEvent b) { return a.atMs.CompareTo(b.atMs); });
            output.visualFrames = new List<RecordedFrame>(VisualFrames);
            output.warnings = new List<string>(Warnings);
        }
        File.WriteAllText(outputPath, new JavaScriptSerializer().Serialize(output), new UTF8Encoding(false));
    }

    private static void Stop(string reason)
    {
        stopping = true;
        stopReason = String.IsNullOrEmpty(reason) ? "controller" : reason;
        CaptureVisualEvidence(true, "final");
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
