#Requires AutoHotkey v2.0

; Auto-elevate to admin if not already running as admin
if not A_IsAdmin {
    try Run '*RunAs "' A_ScriptFullPath '"'
    ExitApp
}

; Maps the "Back" side button (closer to your thumb/wrist) to Win + H (Windows voice-to-text)
XButton1::Send "#h"

; Maps the "Forward" side button (closer to the screen) to PAN Dictation
; Press once to start, press again to stop early. Auto-stops after 3s silence.
panDir := "C:\Users\tzuri\OneDrive\Desktop\PAN\service\src"
panBusy := false
panStopFile := A_Temp "\pan_dictate.wav.stop"

XButton2:: {
    global panDir, panBusy, panStopFile
    if (panBusy) {
        ; Already recording — signal stop
        try
            FileAppend("stop", panStopFile)
        ToolTip("PAN: Stopping...")
        return
    }
    panBusy := true
    SoundBeep(800, 150)  ; Short high beep = recording started
    ToolTip("Π Listening...")

    ; Record with voice activity detection — stops after 3s silence
    ; Write output to temp file to avoid visible console window
    outFile := A_Temp "\pan_stt_result.json"
    try
        FileDelete(outFile)
    RunWait('cmd /c python "' panDir '\dictate-vad.py" > "' outFile '" 2>&1', , "Hide")
    try {
        output := FileRead(outFile)
        try
            FileDelete(outFile)

        if InStr(output, '"text"') {
            RegExMatch(output, '"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*', &m)
            if m {
                text := m[1]
                text := StrReplace(text, "\\n", " ")
                text := StrReplace(text, '\\"', '"')
                text := StrReplace(text, "\\\\", "\")
                if (text != "") {
                    SoundBeep(600, 100)  ; Lower beep = done
                    ToolTip("PAN: " SubStr(text, 1, 60))
                    SendText(text)
                    Sleep(1500)
                } else {
                    ToolTip("PAN: No speech")
                    Sleep(1000)
                }
            }
        } else {
            ToolTip("PAN: " SubStr(output, 1, 80))
            Sleep(2000)
        }
    } catch as e {
        ToolTip("PAN: Error - " e.Message)
        Sleep(2000)
    }
    ToolTip()
    panBusy := false
}