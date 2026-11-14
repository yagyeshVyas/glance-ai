// Frame sender for the vendored UnityCapture virtual camera.
//
// Reads length-framed RGBA frames from a named pipe and copies them into the
// shared section the filter exposes to a DirectShow consumer. UnityCapture's
// protocol is four named objects (see vendor/unitycapture LICENSE and upstream
// Source/shared.inl):
//
//   mutex  UnityCapture_Mutx     guards the header + pixels
//   event  UnityCapture_Want     consumer asks for the next frame
//   event  UnityCapture_Sent     sender published a frame
//   map    UnityCapture_Data     header {maxSize,width,height,stride,format,resize,mirror,timeout} + pixels
//
// The filter creates these when a consumer opens the camera; this process waits
// for them, so start the consumer first (or let this idle until it appears).
//
// Pipe protocol, little-endian: int32 width, height, stride, format, then
// stride*height bytes of pixel data. Run: compiled by scripts/vcam-pattern.js.
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

internal static class VcamSender
{
    const uint SYNCHRONIZE = 0x00100000;
    const uint EVENT_MODIFY_STATE = 0x0002;
    const uint FILE_MAP_WRITE = 0x0002;
    const uint INFINITE = 0xFFFFFFFF;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern IntPtr OpenMutex(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern IntPtr OpenEvent(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern IntPtr OpenFileMapping(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr MapViewOfFile(IntPtr map, uint access, uint offsetHigh, uint offsetLow, UIntPtr bytes);
    [DllImport("kernel32.dll")]
    static extern bool UnmapViewOfFile(IntPtr view);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")]
    static extern bool ReleaseMutex(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
    static extern IntPtr CreateEvent(IntPtr attributes, bool manualReset, bool initialState, string name);

    static IntPtr WaitOpen(Func<IntPtr> open, int timeoutMs)
    {
        var deadline = Environment.TickCount + timeoutMs;
        while (Environment.TickCount < deadline)
        {
            IntPtr h = open();
            if (h != IntPtr.Zero) return h;
            Thread.Sleep(100);
        }
        return IntPtr.Zero;
    }

    static int Main(string[] args)
    {
        string pipeName = args.Length > 0 ? args[0] : "glance-vcam";

        // Order matters, and it is the reverse of what it looks like: the
        // filter OPENS the "want" event (it does not create it), so the sender
        // must create it before the filter's first Receive can get past its
        // setup. Only then does the filter create the mutex, the "sent" event
        // and the shared section. Creating the want event first is what breaks
        // the deadlock the first version sat in.
        IntPtr want = CreateEvent(IntPtr.Zero, false, false, "UnityCapture_Want");
        if (want == IntPtr.Zero) return 8;
        IntPtr mutex = WaitOpen(() => OpenMutex(SYNCHRONIZE, false, "UnityCapture_Mutx"), 60000);
        if (mutex == IntPtr.Zero) return 2;
        IntPtr map = WaitOpen(() => OpenFileMapping(FILE_MAP_WRITE, false, "UnityCapture_Data"), 10000);
        if (map == IntPtr.Zero) return 3;
        IntPtr view = MapViewOfFile(map, FILE_MAP_WRITE, 0, 0, UIntPtr.Zero);
        if (view == IntPtr.Zero) return 4;
        Console.WriteLine("sender: shared objects found");
        IntPtr sent = WaitOpen(() => OpenEvent(EVENT_MODIFY_STATE, false, "UnityCapture_Sent"), 10000);

        using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.In))
        {
            try { client.Connect(30000); Console.WriteLine("sender: connected to pipe"); } catch { return 5; }
            var reader = new BinaryReader(client);
            while (true)
            {
                int width, height, stride, format;
                byte[] pixels;
                try
                {
                    width = reader.ReadInt32();
                    height = reader.ReadInt32();
                    stride = reader.ReadInt32();
                    format = reader.ReadInt32();
                    int size = stride * height;
                    if (size <= 0 || size > 3840 * 2160 * 4) return 6;
                    pixels = reader.ReadBytes(size);
                    if (pixels.Length != size) return 7;
                }
                catch { return 0; } // producer closed

                WaitForSingleObject(mutex, INFINITE);
                // header offsets: maxSize 0, width 4, height 8, stride 12,
                // format 16, resizemode 20, mirrormode 24, timeout 28, data 32
                Marshal.WriteInt32(view, 4, width);
                Marshal.WriteInt32(view, 8, height);
                Marshal.WriteInt32(view, 12, stride);
                Marshal.WriteInt32(view, 16, format);
                Marshal.WriteInt32(view, 20, 0); // no resize
                Marshal.WriteInt32(view, 24, 0); // no mirror
                Marshal.WriteInt32(view, 28, 200);
                Marshal.Copy(pixels, 0, new IntPtr(view.ToInt64() + 32), pixels.Length);
                ReleaseMutex(mutex);

                if (sent != IntPtr.Zero) SetEvent(sent);
                if (want != IntPtr.Zero) WaitForSingleObject(want, 500);
            }
        }
    }
}

