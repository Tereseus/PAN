' PAN Launcher — runs PAN.bat in a visible console window (required for node-pty)
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & Replace(WScript.ScriptFullName, "PAN.vbs", "PAN.bat") & Chr(34), 1, False
