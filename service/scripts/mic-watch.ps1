# Tells the hub when another program on this computer is recording from the microphone, so the
# voice assistant does not answer what is being dictated to that program (the phone hears it too).
# Hub side: POST /api/v1/voice/dictating (conv-state-watcher.js, noteDictation).
#
# How it knows: Windows Core Audio capture sessions. A program that has the mic open has a session;
# state 1 = recording now, 0 = open but idle. The Claude desktop app's own dictation shows up this
# way (seen 2026-11-17: idle at 0, a 2.5 minute dictation at 1, back to 0).
#
#   -Once         print which programs have the mic open, and stop
#   -Match        process name to watch (a regular expression), default claude
#   -Minutes      how long to run; 0 = until stopped
# The hub's address is one line in %LOCALAPPDATA%\PAN\hub-url.txt. No file, nothing is sent.
param([switch]$Once, [string]$Match = 'claude', [int]$Minutes = 0, [string]$Log = "$env:LOCALAPPDATA\PAN\logs\mic-watch.log")

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class MicSessions {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int n);
    [PreserveSig] int Item(int i, out IMMDevice d);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int n);
    [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
  }
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr n);
    [PreserveSig] int SetDisplayName(IntPtr v, IntPtr ctx);
    [PreserveSig] int GetIconPath(out IntPtr p);
    [PreserveSig] int SetIconPath(IntPtr v, IntPtr ctx);
    [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(IntPtr g, IntPtr ctx);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier(out IntPtr s);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr s);
    [PreserveSig] int GetProcessId(out uint pid);
  }

  // "pid:state" for every capture session; state 1 = recording now, 0 = open but idle.
  public static List<string> List() {
    var outp = new List<string>();
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection col;
    if (en.EnumAudioEndpoints(1, 1, out col) != 0) return outp;      // eCapture, DEVICE_STATE_ACTIVE
    int n; col.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IMMDevice dev; if (col.Item(i, out dev) != 0) continue;
      Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
      object o; if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
      IAudioSessionEnumerator se; if (((IAudioSessionManager2)o).GetSessionEnumerator(out se) != 0) continue;
      int m; se.GetCount(out m);
      for (int j = 0; j < m; j++) {
        IAudioSessionControl2 s; if (se.GetSession(j, out s) != 0) continue;
        int st; uint pid; s.GetState(out st); s.GetProcessId(out pid);
        outp.Add(pid + ":" + st);
        Marshal.ReleaseComObject(s);
      }
      Marshal.ReleaseComObject(se); Marshal.ReleaseComObject(o); Marshal.ReleaseComObject(dev);
    }
    return outp;
  }
}
"@

function Recording([string]$match) {
  $names = @()
  foreach ($e in [MicSessions]::List()) {
    $procId, $st = $e.Split(':')
    $name = try { (Get-Process -Id ([int]$procId) -ErrorAction Stop).ProcessName } catch { "pid$procId" }
    $names += [pscustomobject]@{ Name = $name; State = [int]$st }
  }
  return $names
}

if ($Once) { Recording $Match | Sort-Object Name, State -Unique | Format-Table -AutoSize; return }

$hub = ''
try { $hub = (Get-Content "$env:LOCALAPPDATA\PAN\hub-url.txt" -Raw).Trim() } catch {}
$was = $false
$until = if ($Minutes -gt 0) { (Get-Date).AddMinutes($Minutes) } else { [DateTime]::MaxValue }
"$(Get-Date -Format 'HH:mm:ss') watching '$Match' for $Minutes min (hub: $([bool]$hub))" | Out-File $Log -Append -Encoding utf8
while ((Get-Date) -lt $until) {
  $now = [bool](Recording $Match | Where-Object { $_.Name -match $Match -and $_.State -eq 1 })
  if ($now -ne $was) {
    "$(Get-Date -Format 'HH:mm:ss') $Match recording: $now" | Out-File $Log -Append -Encoding utf8
    if ($hub) {
      try { Invoke-RestMethod -Method Post -Uri "$hub/api/v1/voice/dictating" -ContentType 'application/json' -Body (@{ on = $now } | ConvertTo-Json) -TimeoutSec 3 | Out-Null } catch {}
    }
    $was = $now
  }
  Start-Sleep -Milliseconds 700
}
