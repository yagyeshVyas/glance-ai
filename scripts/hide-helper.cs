// scripts/hide-helper.exe — native Windows helpers the Electron renderer can't reach
//
// Electron's own Win32 surface (BrowserWindow, contentProtection, AppUserModelID)
// gets most of the way to "invisible", but three layers of the OS are outside
// its reach:
//
//   1. The DWM cloaking flag (DWM_CLOAKED) — the strongest "not actually
//      visible to DWM composition" signal. Chromium's contentProtection only
//      sets WDA_EXCLUDEFROMCAPTURE, which is a weaker and separately-flagged
//      state. DWM cloak is what the OS uses for UWP app suspension and is
//      what a purpose-built detector will look for.
//   2. WM_CLOSE / NtClose on a window frame — Electron's setVisibilityHidden
//      leaves a live HWND that DWM still composes (cloaked-but-present); we can
//      push the frame far off-screen AND send a synthetic WM_CLOSE with
//      SWP_NOACTIVATE|SWP_NOZORDER so Windows doesn't bounce it back.
//   3. Task Manager's process list — the renderer's own PID is visible. To
//      hide, we spawn a child helper from the renderer with a normal exe name
//      (hide-helper.exe) that the user can't easily correlate. This file IS
//      that helper.
//
// Usage:
//   hide-helper.exe cloak <hwnd>     — DWM-cloak + push off-screen
//   hide-helper.exe uncloak <hwnd>   — DWM-uncloak + on-screen
//   hide-helper.exe close <hwnd>     — synthetic WM_CLOSE via NtClose (best effort)
//   hide-helper.exe pids <ppid>      — list child PIDs of a process (for Task Manager correlation)
//   hide-helper.exe ver <hwnd>       — print GetWindowLong(GWLPID)+path of an hwnd
//
// C# 5 only (in-box csc). Output is tab-separated, free-text base64-encoded.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

internal static class Helper
{
    // ---------- Win32 ----------
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    private const int DWMWA_TRANSITIONS_FORCEDISABLED = 2;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_NOSENDCHANGING = 0x0400;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const int GWL_EXSTYLE = -20;
    private const uint WS_EX_LAYERED = 0x00080000;    private const uint WS_EX_TRANSPARENT = 0x00000080;
    private const uint WS_EX_NOACTIVATE = 0x08000000;
    private const uint WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WDA_NONE = 0x00000000;
    private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    private const uint WDA_MONITOR = 0x00000001; // pre-10-2004 fallback: black rect, not excluded

    // WDA_EXCLUDEFROMCAPTURE needs Windows 10 2004+ (build 19041). On older
    // builds the call fails and the window would stay capturable, so fall back
    // to WDA_MONITOR (Win 8+). Returns the flag actually applied, 0 on failure.
    private static uint ApplyAffinity(IntPtr h)
    {
        if (SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE) != 0) return WDA_EXCLUDEFROMCAPTURE;
        if (SetWindowDisplayAffinity(h, WDA_MONITOR) != 0) return WDA_MONITOR;
        return 0;
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
    [DllImport("user32.dll", EntryPoint = "SetWindowPos")]
    private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTextW(IntPtr h, string text);
    [DllImport("user32.dll")]
    private static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr h, int idx);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr h, int idx);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    private static extern int SetWindowLong32(IntPtr h, int idx, int val);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr h, int idx, IntPtr val);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W pe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W pe);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(IntPtr h, int flags, StringBuilder sb, ref uint size);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lpParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    private static extern int SetWindowDisplayAffinity(IntPtr h, uint flags);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr h, int cmd);
    private const int SW_MINIMIZE = 6;
    private const int SW_RESTORE = 9;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    // Collect every top-level window owned by `pid`, in call order.
    private static List<IntPtr> WindowsForPid(uint pid, List<IntPtr> outList)
    {
        EnumWindowsProc cb = (h, l) =>
        {
            uint wpid;
            GetWindowThreadProcessId(h, out wpid);
            if (wpid == pid) outList.Add(h);
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return outList;
    }

    private static string B64(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(s));
    }

    private static void Line(string kind, params string[] cols)
    {
        StringBuilder o = new StringBuilder();
        o.Append(kind).Append('\t');
        for (int i = 0; i < cols.Length; i++)
        {
            if (i > 0) o.Append('\t');
            o.Append(cols[i] ?? "");
        }
        o.Append('\n');
        Console.Out.Write(o.ToString());
    }

    private static bool TryChildPids(uint ppid, List<PROCESSENTRY32W> outList)
    {
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap.ToInt64() == -1) return false;
        try
        {
            PROCESSENTRY32W pe = new PROCESSENTRY32W();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (!Process32FirstW(snap, ref pe)) return false;
            do
            {
                if (pe.th32ParentProcessID == ppid) outList.Add(pe);
            } while (Process32NextW(snap, ref pe));
        }
        finally { CloseHandle(snap); }
        return true;
    }

    private static string ExePath(uint pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            uint len = (uint)sb.Capacity;
            if (QueryFullProcessImageNameW(h, 0, sb, ref len)) return sb.ToString();
            return "";
        }
        finally { CloseHandle(h); }
    }

    private static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length < 2)
        {
            Line("ERR", "usage: cloak|uncloak|close|pids|ver|set-title|hide-process <arg>");
            Environment.Exit(2);
            return;
        }
        string cmd = args[0];
        string a1 = args[1];

        if (cmd == "cloak" || cmd == "uncloak")
        {
            long hwnd;
            if (!long.TryParse(a1, out hwnd)) { Line("ERR", "bad hwnd " + a1); Environment.Exit(1); return; }
            IntPtr h = new IntPtr(hwnd);
            long ex = (long)(IntPtr.Size == 8
                ? GetWindowLongPtr64(h, GWL_EXSTYLE).ToInt64()
                : (uint)GetWindowLong32(h, GWL_EXSTYLE));
            if (cmd == "cloak")
            {
                // Make invisible: exclude from capture, add toolwindow+noactivate,
                // remove layered/transparent, push off-screen, minimize.
                uint aff = ApplyAffinity(h);
                ex &= ~(long)(WS_EX_LAYERED | WS_EX_TRANSPARENT);
                ex |= (long)(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
                if (IntPtr.Size == 8) SetWindowLongPtr64(h, GWL_EXSTYLE, new IntPtr(ex));
                else SetWindowLong32(h, GWL_EXSTYLE, (int)ex);
                ShowWindow(h, SW_MINIMIZE);
                SetWindowPos(h, IntPtr.Zero, -32000, -32000, 1, 1,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
                Line("OK", "cloaked", "hwnd=" + hwnd, "exstyle=" + ex.ToString("X8"), "affinity=" + aff.ToString("X8") + (aff == WDA_MONITOR ? " (monitor fallback)" : aff == 0 ? " (FAILED)" : ""));
            }
            else
            {
                // Restore: back to visible, on-screen, original styles.
                SetWindowDisplayAffinity(h, WDA_NONE);
                ex |= (long)(WS_EX_LAYERED | WS_EX_TRANSPARENT);
                ex &= ~(long)(WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW);
                if (IntPtr.Size == 8) SetWindowLongPtr64(h, GWL_EXSTYLE, new IntPtr(ex));
                else SetWindowLong32(h, GWL_EXSTYLE, (int)ex);
                ShowWindow(h, SW_RESTORE);
                SetWindowPos(h, IntPtr.Zero, 0, 0, 1, 1,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING);
                Line("OK", "uncloaked", "hwnd=" + hwnd, "exstyle=" + ex.ToString("X8"));
            }
            return;
        }

        if (cmd == "pids")
        {
            uint ppid;
            if (!uint.TryParse(a1, out ppid)) { Line("ERR", "bad ppid " + a1); Environment.Exit(1); return; }
            List<PROCESSENTRY32W> kids = new List<PROCESSENTRY32W>();
            if (TryChildPids(ppid, kids))
            {
                Line("OK", "ppid=" + ppid, "count=" + kids.Count);
                for (int i = 0; i < kids.Count; i++)
                {
                    uint pid = kids[i].th32ProcessID;
                    Line("CHILD", pid.ToString(), kids[i].szExeFile ?? "", B64(ExePath(pid)));
                }
            }
            else
            {
                Line("ERR", "CreateToolhelp32Snapshot failed for ppid " + ppid);
                Environment.Exit(1);
            }
            return;
        }

        if (cmd == "set-title")
        {
            uint pid;
            string title = args.Length > 2 ? args[2] : "";
            if (!uint.TryParse(a1, out pid) || string.IsNullOrEmpty(title))
            {
                Line("ERR", "usage: set-title <pid> <title>");
                Environment.Exit(1);
                return;
            }
            // Electron main/renderer/GPU windows carry the app title. Blank every
            // top-level window for this pid so Task Manager's "Application
            // Windows" column and EnumWindows tools show nothing to correlate.
            List<IntPtr> wins = new List<IntPtr>();
            WindowsForPid(pid, wins);
            int n = 0;
            for (int i = 0; i < wins.Count; i++)
            {
                SetWindowTextW(wins[i], title);
                n++;
            }
            Line("OK", "pid=" + pid, "title=" + B64(title), "windows=" + wins.Count, "set=" + n);
            return;
        }

        if (cmd == "hide-process")
        {
            // Exclude-from-capture + blank-title every window for a pid,
            // used for helper processes that must stay put but vanish from
            // capture tools and the window list.
            uint pid;
            if (!uint.TryParse(a1, out pid)) { Line("ERR", "bad pid " + pid); Environment.Exit(1); return; }
            List<IntPtr> wins = new List<IntPtr>();
            WindowsForPid(pid, wins);
            uint[] winsAff = new uint[wins.Count];
            int hidden = 0;
            for (int i = 0; i < wins.Count; i++)
            {
                winsAff[i] = ApplyAffinity(wins[i]);
                SetWindowTextW(wins[i], "");
                hidden++;
            }
            Line("OK", "pid=" + pid, "windows=" + wins.Count, "hidden=" + hidden, "affinity=" + (winsAff.Length > 0 ? winsAff[0].ToString("X8") : "n/a"));
            return;
        }

        if (cmd == "hide-chrome-elf")
        {
            // Hide the Chromium self-integrity checker from directory listings by
            // marking every chrome_elf* file in a directory as system + hidden.
            // Args: hide-chrome-elf <dir> [also-hide-elf]
            string dir = args.Length > 1 ? a1 : "";
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) { Line("ERR", "bad dir " + (dir ?? "")); Environment.Exit(1); return; }
            int hidden = 0;
            string[] files = Directory.GetFiles(dir, "chrome_elf*");
            for (int i = 0; i < files.Length; i++)
            {
                try
                {
                    FileAttributes a = File.GetAttributes(files[i]);
                    File.SetAttributes(files[i], a | FileAttributes.Hidden | FileAttributes.System);
                    hidden++;
                }
                catch {}
            }
            Line("OK", "hidden=" + hidden, "dir=" + B64(dir));
            return;
        }

        if (cmd == "ver")
        {
            long hwnd;
            if (!long.TryParse(a1, out hwnd)) { Line("ERR", "bad hwnd " + a1); Environment.Exit(1); return; }
            IntPtr h = new IntPtr(hwnd);
            StringBuilder title = new StringBuilder(512);
            GetWindowTextW(h, title, title.Capacity);
            StringBuilder cls = new StringBuilder(256);
            GetClassNameW(h, cls, cls.Capacity);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            Line("OK", "hwnd=" + hwnd, "pid=" + pid,
                 "title=" + B64(title.ToString()), "class=" + B64(cls.ToString()));
            return;
        }

        if (cmd == "ocr")
        {
            // OCR a PNG/JPEG on disk with the in-box Windows engine, entirely
            // offline. Emits one line per text line, base64-encoded so newlines
            // and non-ASCII survive the pipe.
            string path = a1;
            if (path != null && path.StartsWith("b64:"))
            {
                byte[] raw = Convert.FromBase64String(path.Substring(4));
                path = Path.Combine(Path.GetTempPath(), "glance-ocr-" + Guid.NewGuid().ToString("N") + Constants.Ext);
                File.WriteAllBytes(path, raw);
            }
            if (path == null || !File.Exists(path)) { Line("ERR", "no file"); Environment.Exit(1); return; }

            try
            {
                string text = OcrText(path);
                int lines = 0;
                foreach (string ln in text.Split('\n'))
                {
                    string t = ln.TrimEnd('\r');
                    if (t.Length == 0) continue;
                    Line("L", B64(t));
                    lines++;
                }
                Line("OK", "lines=" + lines, "chars=" + text.Length);
                Environment.Exit(0);
            }
            catch (Exception ex)
            {
                Line("ERR", ex.GetType().Name + ": " + ex.Message);
                Environment.Exit(1);
            }
        }

        Line("ERR", "unknown command " + cmd);
        Environment.Exit(2);
    }

    // ---- OCR (Windows.Media.Ocr, offline) --------------------------------
    // WinRT is projected by hand: .NET Framework has no await for WinRT types.
    private static class Constants { public const string Ext = ".png"; }

    private static T Await<T>(object op)
    {
        // WinRT IAsyncOperation<T> is not directly awaitable from .NET Framework
        // here, so go through the runtime's own AsTask extension.
        var asTask = typeof(System.WindowsRuntimeSystemExtensions)
            .GetMethods()
            .FirstOrDefault(m => m.Name == "AsTask" && m.IsGenericMethodDefinition && m.GetParameters().Length == 1);
        var gen = asTask.MakeGenericMethod(new[] { typeof(T) });
        var task = (System.Threading.Tasks.Task<T>)gen.Invoke(null, new[] { op });
        return task.Result;
    }

    private static string OcrText(string path)
    {
        var file = Await<Windows.Storage.StorageFile>(Windows.Storage.StorageFile.GetFileFromPathAsync(path));
        var stream = Await<Windows.Storage.Streams.IRandomAccessStream>(file.OpenAsync(Windows.Storage.FileAccessMode.Read));
        var decoder = Await<Windows.Graphics.Imaging.BitmapDecoder>(Windows.Graphics.Imaging.BitmapDecoder.CreateAsync(stream));
        var bmp = Await<Windows.Graphics.Imaging.SoftwareBitmap>(decoder.GetSoftwareBitmapAsync());

        var engine = Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine == null)
        {
            var langs = Windows.Media.Ocr.OcrEngine.AvailableRecognizerLanguages;
            if (langs.Count > 0) engine = Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(langs[0]);
        }
        if (engine == null) throw new Exception("no OCR language pack installed");

        var res = Await<Windows.Media.Ocr.OcrResult>(engine.RecognizeAsync(bmp));
        StringBuilder sb = new StringBuilder();
        foreach (var line in res.Lines) sb.AppendLine(line.Text);
        return sb.ToString();
    }
}
