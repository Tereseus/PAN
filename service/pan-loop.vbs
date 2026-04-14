Set WshShell = CreateObject("WScript.Shell")
' Run the loop batch file hidden (0) and don't wait for it to finish (False)
WshShell.Run "cmd /c ""pan-loop.bat""", 0, False
