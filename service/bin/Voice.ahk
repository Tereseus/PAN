#Requires AutoHotkey v2.0

; === Paths ===
panDir := "C:\Users\tzuri\Desktop\PAN\service\src"
sndDir := "C:\Users\tzuri\Desktop\PAN\service\bin\sounds"
panTriggerFile := A_Temp "\pan_voice_trigger"
panStopFile := A_Temp "\pan_dictate.wav.stop"
panBusy := false

; === Signal file for dashboard mic button ===
SetTimer(CheckDashboardMicTrigger, 250)

CheckDashboardMicTrigger() {
    global panTriggerFile
    if FileExist(panTriggerFile) {
        try {
            content := FileRead(panTriggerFile)
            FileDelete(panTriggerFile)
        }
        if (content = "winh") {
            Send "#h"
        } else if (content = "dictate") {
            DoPanDictation()
        }
    }
}

; Back side button = Windows voice-to-text
XButton1::Send "#h"

; Forward side button = PAN Dictation
XButton2:: {
    DoPanDictation()
}

DoPanDictation() {
    global panBusy, panDir, sndDir, panStopFile
    if (panBusy) {
        try FileAppend("stop", panStopFile)
        return
    }
    panBusy := true

    try SoundPlay(sndDir "\voice-start.wav")
    ToolTip("Π Listening...")

    try {
        RunWait('python.exe "' panDir '\dictate-vad.py"',, "Hide")
    } catch as e {
        ToolTip("PAN: Dictation failed - " e.Message)
        Sleep(2000)
    }

    try SoundPlay(sndDir "\voice-stop.wav", true)
    ToolTip()
    panBusy := false
}
