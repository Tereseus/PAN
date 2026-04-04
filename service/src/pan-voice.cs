using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

/// <summary>
/// PAN Voice Hotkey Listener — standalone, no dependencies.
/// Listens for configurable mouse/keyboard hotkeys:
///   XButton2 (forward mouse) = PAN Whisper dictation
///   XButton1 (back mouse) = Windows voice-to-text (Win+H)
/// Compiles itself via dotnet/csc — zero install needed.
/// Config: %LOCALAPPDATA%\PAN\data\voice-config.json
/// </summary>
class PanVoice
{
    // Win32 mouse hook
    private const int WH_MOUSE_LL = 14;
    private const int WM_XBUTTONDOWN = 0x020B;
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;

    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, LowLevelProc cb, IntPtr hMod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr wp, IntPtr lp);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("kernel32.dll")] static extern IntPtr LoadLibrary(string name);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int ptX, ptY; }

    delegate IntPtr LowLevelProc(int code, IntPtr wp, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x, y, mouseData, flags, time; public IntPtr extra; }

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public int vkCode, scanCode, flags, time; public IntPtr extra; }

    static IntPtr mouseHook, kbHook;
    static LowLevelProc mouseProc, kbProc;
    static volatile bool busy = false;
    static string dictateScript;
    static string configPath;

    // Config
    static int whisperButton = 2;  // XButton2 (forward)
    static int winVoiceButton = 1; // XButton1 (back)
    static int whisperKey = 0;     // 0 = disabled, or VK code
    static int winVoiceKey = 0;    // 0 = disabled, or VK code

    [STAThread]
    static void Main(string[] args)
    {
        var panDir = @"C:\Users\tzuri\Desktop\PAN\service\src";
        dictateScript = Path.Combine(panDir, "dictate-vad.py");
        configPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PAN", "data", "voice-config.json");

        LoadConfig();
        Log("PAN Voice started. Whisper=XButton" + whisperButton + ", WinVoice=XButton" + winVoiceButton);

        // Install mouse hook — IntPtr.Zero works for LL hooks per MSDN docs
        // Also try GetModuleHandle(null) as fallback
        var hMod = GetModuleHandle(null);
        if (hMod == IntPtr.Zero) hMod = LoadLibrary("user32.dll");
        Log("Hook module handle: " + hMod.ToString());

        mouseProc = new LowLevelProc(MouseCallback);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, hMod, 0);
        Log("Mouse hook handle: " + mouseHook.ToString());
        if (mouseHook == IntPtr.Zero)
        {
            Log("ERROR: SetWindowsHookEx failed! LastError=" + Marshal.GetLastWin32Error());
        }

        if (whisperKey > 0 || winVoiceKey > 0)
        {
            kbProc = new LowLevelProc(KeyboardCallback);
            kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, hMod, 0);
        }

        Log("Hooks installed. Listening...");

        // Raw Win32 message loop — most reliable for low-level hooks
        Log("Entering message loop...");
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        Log("Message loop exited");

        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        if (kbHook != IntPtr.Zero) UnhookWindowsHookEx(kbHook);
    }

    static void LoadConfig()
    {
        try
        {
            if (File.Exists(configPath))
            {
                var json = File.ReadAllText(configPath);
                // Simple regex JSON parsing (no System.Text.Json in .NET Framework 4.x)
                var m1 = Regex.Match(json, "\"whisper_mouse_button\"\\s*:\\s*(\\d+)");
                if (m1.Success) whisperButton = int.Parse(m1.Groups[1].Value);
                var m2 = Regex.Match(json, "\"win_voice_mouse_button\"\\s*:\\s*(\\d+)");
                if (m2.Success) winVoiceButton = int.Parse(m2.Groups[1].Value);
                var m3 = Regex.Match(json, "\"whisper_key_vk\"\\s*:\\s*(\\d+)");
                if (m3.Success) whisperKey = int.Parse(m3.Groups[1].Value);
                var m4 = Regex.Match(json, "\"win_voice_key_vk\"\\s*:\\s*(\\d+)");
                if (m4.Success) winVoiceKey = int.Parse(m4.Groups[1].Value);

                Log("Config loaded: whisper=XButton" + whisperButton + ", winVoice=XButton" + winVoiceButton);
            }
            else
            {
                // Write default config
                Directory.CreateDirectory(Path.GetDirectoryName(configPath));
                var defaults = @"{
  ""whisper_mouse_button"": 2,
  ""win_voice_mouse_button"": 1,
  ""whisper_key_vk"": 0,
  ""win_voice_key_vk"": 0,
  ""_help"": ""Mouse buttons: 1=back(XButton1), 2=forward(XButton2). Key VK codes: 0=disabled. See https://learn.microsoft.com/en-us/windows/win32/inputdev/virtual-key-codes""
}";
                File.WriteAllText(configPath, defaults);
                Log("Default config written to " + configPath);
            }
        }
        catch (Exception ex)
        {
            Log("Config error: " + ex.Message);
        }
    }

    static IntPtr MouseCallback(int code, IntPtr wp, IntPtr lp)
    {
        Log("Mouse event: code=" + code + " wp=0x" + ((int)wp).ToString("X") + " lp=" + lp);
        if (code >= 0 && ((int)wp == WM_XBUTTONDOWN || (int)wp == 0x020C)) // WM_XBUTTONDOWN or WM_XBUTTONUP
        {
            var data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lp, typeof(MSLLHOOKSTRUCT));
            int button = (data.mouseData >> 16) & 0xFFFF;

            // Block XButton events entirely — return 1 to eat them (no navigate back/forward)
            if (button == whisperButton || button == winVoiceButton)
            {
                if ((int)wp == WM_XBUTTONDOWN) // Only act on button down, not up
                {
                    if (button == whisperButton)
                    {
                        ThreadPool.QueueUserWorkItem(delegate { DoWhisperDictation(); });
                    }
                    else if (button == winVoiceButton)
                    {
                        // Win+H
                        keybd_event(0x5B, 0, 0, UIntPtr.Zero); // Win down
                        keybd_event(0x48, 0, 0, UIntPtr.Zero); // H down
                        keybd_event(0x48, 0, 2, UIntPtr.Zero); // H up
                        keybd_event(0x5B, 0, 2, UIntPtr.Zero); // Win up
                    }
                }
                return (IntPtr)1; // BLOCK the event — don't pass to apps
            }
        }
        return CallNextHookEx(mouseHook, code, wp, lp);
    }

    static IntPtr KeyboardCallback(int code, IntPtr wp, IntPtr lp)
    {
        if (code >= 0 && (int)wp == WM_KEYDOWN)
        {
            var data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lp, typeof(KBDLLHOOKSTRUCT));
            if (data.vkCode == whisperKey)
                ThreadPool.QueueUserWorkItem(_ => DoWhisperDictation());
            else if (data.vkCode == winVoiceKey)
            {
                keybd_event(0x5B, 0, 0, UIntPtr.Zero);
                keybd_event(0x48, 0, 0, UIntPtr.Zero);
                keybd_event(0x48, 0, 2, UIntPtr.Zero);
                keybd_event(0x5B, 0, 2, UIntPtr.Zero);
            }
        }
        return CallNextHookEx(kbHook, code, wp, lp);
    }

    static void DoWhisperDictation()
    {
        if (busy) return;
        busy = true;
        try
        {
            Console.Beep(800, 150); // Recording started
            Log("Recording...");

            var outFile = Path.Combine(Path.GetTempPath(), "pan_stt_result.json");
            if (File.Exists(outFile)) File.Delete(outFile);

            var psi = new ProcessStartInfo
            {
                FileName = "python",
                Arguments = "\"" + dictateScript + "\"",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            var dictProc = Process.Start(psi);
            var output = dictProc.StandardOutput.ReadToEnd();
            dictProc.WaitForExit(120000);

            if (!string.IsNullOrEmpty(output))
            {
                var match = Regex.Match(output, "\"text\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
                if (match.Success)
                {
                    var text = match.Groups[1].Value
                        .Replace("\\n", " ")
                        .Replace("\\\"", "\"")
                        .Replace("\\\\", "\\")
                        .Trim();

                    if (text.Length > 0)
                    {
                        Console.Beep(600, 100); // Done
                        Log("Transcribed: " + text.Substring(0, Math.Min(60, text.Length)));
                        SendKeys.SendWait(EscapeForSendKeys(text));
                    }
                    else
                    {
                        Log("No speech detected");
                    }
                }
                else
                {
                    Log("No text in output: " + output.Substring(0, Math.Min(80, output.Length)));
                }
            }
        }
        catch (Exception ex)
        {
            Log("Dictation error: " + ex.Message);
        }
        finally
        {
            busy = false;
        }
    }

    static string EscapeForSendKeys(string text)
    {
        // SendKeys treats +, ^, %, ~, {, }, (, ) as special chars
        return text
            .Replace("{", "{{}").Replace("}", "{}}")
            .Replace("+", "{+}").Replace("^", "{^}")
            .Replace("%", "{%}").Replace("~", "{~}")
            .Replace("(", "{(}").Replace(")", "{)}");
    }

    static void Log(string msg)
    {
        var line = "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg;
        Console.WriteLine(line);
        try
        {
            var logDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PAN", "data");
            Directory.CreateDirectory(logDir);
            File.AppendAllText(Path.Combine(logDir, "voice.log"), line + "\n");
        }
        catch { }
    }
}
