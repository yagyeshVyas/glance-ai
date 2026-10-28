// Fast probe for scripts/detect-audit.js — one pass, no PowerShell.
//
// Compiled on first use with the in-box .NET Framework compiler
// (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe) and cached in %TEMP%.
// C# 5 only: that compiler predates C# 6, so no string interpolation, no
// expression-bodied members, no nameof.
//
// Output is line-oriented, tab-separated, free text base64-encoded (console code
// pages mangle non-ASCII; base64 does not). Records:
//   M <screenW> <screenH> <probeMs>
//   W <hwnd> <pid> <exStyle> <style> <w> <h> <affinity> <b64 title> <b64 class>
//   P <pid> <ppid> <b64 name> <b64 path> <b64 description> <b64 company>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Probe
{
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
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

    private sealed class Win
    {
        public long hwnd;
        public int pid;
        public long exStyle;
        public long style;
        public int w;
        public int h;
        public int affinity;
        public string title;
        public string cls;
    }

    private sealed class Proc
    {
        public int pid;
        public int ppid;
        public string name;
        public string path;
        public string desc;
        public string company;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong32(IntPtr h, int idx);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")]
    private static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
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

    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint TH32CS_SNAPPROCESS = 0x00000002;

    private static readonly List<Win> windows = new List<Win>();
    private static readonly EnumWindowsProc enumCallback = OnWindow;

    private static bool OnWindow(IntPtr h, IntPtr l)
    {
        try
        {
            if (!IsWindowVisible(h)) return true;

            int cloaked;
            if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;

            StringBuilder title = new StringBuilder(512);
            GetWindowTextW(h, title, title.Capacity);
            StringBuilder cls = new StringBuilder(256);
            GetClassNameW(h, cls, cls.Capacity);

            uint pid;
            GetWindowThreadProcessId(h, out pid);

            uint affinity = 0;
            bool ok = GetWindowDisplayAffinity(h, out affinity);

            RECT r;
            int w = 0;
            int hh = 0;
            if (GetWindowRect(h, out r))
            {
                w = r.right - r.left;
                hh = r.bottom - r.top;
            }

            Win win = new Win();
            win.hwnd = h.ToInt64();
            win.pid = (int)pid;
            win.exStyle = Style(h, GWL_EXSTYLE);
            win.style = Style(h, GWL_STYLE);
            win.w = w;
            win.h = hh;
            win.affinity = ok ? (int)affinity : -1;
            win.title = title.ToString();
            win.cls = cls.ToString();
            windows.Add(win);
        }
        catch
        {
            // a window can die mid-enumeration; skip it
        }
        return true;
    }

    // GetWindowLongPtrW is not exported by 32-bit user32; only 64-bit needs it.
    private static long Style(IntPtr h, int idx)
    {
        if (IntPtr.Size == 8) return (uint)GetWindowLongPtr(h, idx).ToInt64();
        return (uint)GetWindowLong32(h, idx);
    }

    private static string B64(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(s));
    }

    private static string ExeName(int pid, HashSet<int> windowOwners)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            StringBuilder sb = new StringBuilder(1024);
            uint len = (uint)sb.Capacity;
            if (QueryFullProcessImageNameW(h, 0, sb, ref len)) return sb.ToString();
            return "";
        }
        finally
        {
            CloseHandle(h);
        }
    }

    private static void Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Stopwatch sw = Stopwatch.StartNew();

        EnumWindows(enumCallback, IntPtr.Zero);

        HashSet<int> owners = new HashSet<int>();
        foreach (Win w in windows) owners.Add(w.pid);

        List<Proc> procs = new List<Proc>();
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != IntPtr.Zero && snap.ToInt64() != -1)
        {
            try
            {
                PROCESSENTRY32W pe = new PROCESSENTRY32W();
                pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                bool more = Process32FirstW(snap, ref pe);
                while (more)
                {
                    Proc p = new Proc();
                    p.pid = (int)pe.th32ProcessID;
                    p.ppid = (int)pe.th32ParentProcessID;
                    p.name = pe.szExeFile;
                    p.path = "";
                    p.desc = "";
                    p.company = "";

                    // Path for every process: a detector lists these, and it costs
                    // ~1 ms each. Version resource only where a detector would stop
                    // and read it: window owners, or anything that looks like the app.
                    p.path = ExeName(p.pid, owners);
                    bool interesting = owners.Contains(p.pid) ||
                        (p.name != null && (p.name.IndexOf("wshx-host", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                            p.name.IndexOf("electron", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                            p.name.IndexOf("node", StringComparison.OrdinalIgnoreCase) >= 0));
                    // UNC paths would make FileVersionInfo open an SMB connection
                    // (NetNTLM leak to whoever owns the share) and can block for
                    // seconds. Report the path, never read its version resource.
                    if (interesting && p.path.Length > 0 &&
                        !p.path.StartsWith("\\\\", StringComparison.Ordinal))
                    {
                        try
                        {
                            FileVersionInfo vi = FileVersionInfo.GetVersionInfo(p.path);
                            p.desc = vi.FileDescription == null ? "" : vi.FileDescription;
                            p.company = vi.CompanyName == null ? "" : vi.CompanyName;
                        }
                        catch
                        {
                        }
                    }

                    procs.Add(p);
                    more = Process32NextW(snap, ref pe);
                }
            }
            finally
            {
                CloseHandle(snap);
            }
        }

        StringBuilder o = new StringBuilder(1 << 16);
        o.Append("M\t").Append(GetSystemMetrics(0)).Append('\t')
         .Append(GetSystemMetrics(1)).Append('\t')
         .Append(sw.ElapsedMilliseconds).Append('\n');

        foreach (Win w in windows)
        {
            o.Append("W\t").Append(w.hwnd).Append('\t')
             .Append(w.pid).Append('\t')
             .Append(w.exStyle).Append('\t')
             .Append(w.style).Append('\t')
             .Append(w.w).Append('\t')
             .Append(w.h).Append('\t')
             .Append(w.affinity).Append('\t')
             .Append(B64(w.title)).Append('\t')
             .Append(B64(w.cls)).Append('\n');
        }

        foreach (Proc p in procs)
        {
            o.Append("P\t").Append(p.pid).Append('\t')
             .Append(p.ppid).Append('\t')
             .Append(B64(p.name)).Append('\t')
             .Append(B64(p.path)).Append('\t')
             .Append(B64(p.desc)).Append('\t')
             .Append(B64(p.company)).Append('\n');
        }

        Console.Out.Write(o.ToString());
    }
}
