' PAN Silent Launcher — runs PAN.bat without a visible console window
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & Replace(WScript.ScriptFullName, "PAN.vbs", "PAN.bat") & Chr(34), 0, False
