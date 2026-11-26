// Glance AI OCR helper.
//
// Electron has no OCR API. This helper calls the in-box Windows OCR engine
// (Windows.Media.Ocr) on an image path and prints one base64 line per
// recognised text line. It is offline and has no other commands: no window
// handling, no process inspection, no registry or trust-store access.
//
//   ocr-helper.exe ocr <path-to-png-or-jpeg>
//
// Output is tab-separated; free text is base64 so newlines and non-ASCII
// survive the pipe. C# 5 only (compiled with the in-box csc).

using System;
using System.IO;
using System.Linq;
using System.Text;

internal static class OcrHelper
{
    private static void Line(string kind, params string[] cols)
    {
        StringBuilder o = new StringBuilder();
        o.Append(kind);
        for (int i = 0; i < cols.Length; i++)
        {
            o.Append('\t');
            o.Append(cols[i] ?? "");
        }
        o.Append('\n');
        Console.Out.Write(o.ToString());
    }

    private static string B64(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(s));
    }

    // WinRT is projected by hand: .NET Framework has no await for WinRT types.
    private static T Await<T>(object op)
    {
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

    private static void Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length < 2 || args[0] != "ocr")
        {
            Line("ERR", "usage: ocr <path>");
            Environment.Exit(2);
            return;
        }
        string path = args[1];
        if (!File.Exists(path))
        {
            Line("ERR", "no file");
            Environment.Exit(1);
            return;
        }
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
}
