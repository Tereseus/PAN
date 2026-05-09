// PAN Activity Tracker — polls active foreground window every 3s on Windows
// and logs focus changes to activity_events in the DB.
//
// Usage: startActivityTracker() — call once at server boot (prod only).
// No-op on non-Windows platforms.

import { exec } from 'child_process';
import { run } from './db.js';

// PowerShell snippet — uses Win32 API to get foreground window process name + title.
// Outputs: "<processName>|<windowTitle>"
const PS_GET_WINDOW = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class WinInfo {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  public static string[] GetActive() {
    IntPtr hwnd = GetForegroundWindow();
    int pid = 0;
    GetWindowThreadProcessId(hwnd, out pid);
    try {
      var p = Process.GetProcessById(pid);
      return new string[] { p.ProcessName, p.MainWindowTitle };
    } catch { return new string[] { "", "" }; }
  }
}
"@ -Language CSharp
$r = [WinInfo]::GetActive()
Write-Output ($r[0] + "|" + $r[1])
`.trim();

// Inline the PS script as a single -Command string — replace newlines with semicolons
// and escape double-quotes so it survives shell interpolation.
const PS_CMD = PS_GET_WINDOW
  .replace(/\r?\n/g, ' ')
  .replace(/"/g, '\\"');

let _lastProcessName = '';
let _lastWindowTitle = '';
let _lastFocusTime = Date.now();
let _started = false;

export function startActivityTracker() {
  if (process.platform !== 'win32') return;
  if (_started) return;
  _started = true;

  console.log('[Activity] Tracker started — polling every 3s');
  setInterval(pollActiveWindow, 3000);
}

function pollActiveWindow() {
  exec(
    `powershell -NoProfile -NonInteractive -Command "${PS_CMD}"`,
    { timeout: 4000, windowsHide: true },
    (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return;

      const raw = stdout.trim();
      const pipeIdx = raw.indexOf('|');
      if (pipeIdx === -1) return;

      const processName = raw.slice(0, pipeIdx).trim();
      const windowTitle = raw.slice(pipeIdx + 1).trim();

      if (!processName) return;

      const now = Date.now();

      if (processName !== _lastProcessName || windowTitle !== _lastWindowTitle) {
        // Log the previous window's focus duration before switching
        if (_lastProcessName) {
          const duration = now - _lastFocusTime;
          try {
            run(
              `INSERT INTO activity_events (event_type, app_name, window_title, process_name, duration_ms, source, device_id)
               VALUES ('app_focus', :app, :title, :proc, :dur, 'desktop', 'hub')`,
              {
                ':app': _lastProcessName,
                ':title': _lastWindowTitle,
                ':proc': _lastProcessName,
                ':dur': duration,
              }
            );
          } catch (dbErr) {
            // Non-fatal — DB may not be ready yet
          }
        }

        _lastProcessName = processName;
        _lastWindowTitle = windowTitle;
        _lastFocusTime = now;
      }
    }
  );
}
