; ═══════════════════════════════════════════════════════════════════════════
; PAN Setup — NSIS wrapper
; Compiles install.ps1 into a self-extracting .exe that:
;   1. Extracts itself to a temp folder
;   2. Runs install.ps1 as Administrator
;   3. Cleans up
;
; Build: makensis pan-setup.nsi
; Output: PAN-Setup.exe (~2KB — the real work is in install.ps1)
;
; For a FULL offline installer (bundled Node + deps), use build-offline.ps1
; which prebuilds everything and packs it into the NSIS binary.
; ═══════════════════════════════════════════════════════════════════════════

!include "MUI2.nsh"

Name "PAN — Personal AI Network"
OutFile "PAN-Setup.exe"
InstallDir "$LOCALAPPDATA\PAN"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

; ── UI ──────────────────────────────────────────────────────────────────
!define MUI_ICON "..\service\tauri\src-tauri\icons\icon.ico"
!define MUI_WELCOMEPAGE_TITLE "PAN — Personal AI Network"
!define MUI_WELCOMEPAGE_TEXT "This will install PAN on your computer.$\r$\n$\r$\nPAN is your persistent AI operating system — it never forgets.$\r$\n$\r$\nClick Install to begin."
!define MUI_FINISHPAGE_RUN "$LOCALAPPDATA\PAN\PAN.bat"
!define MUI_FINISHPAGE_RUN_TEXT "Start PAN now"
!define MUI_FINISHPAGE_LINK "Open Dashboard"
!define MUI_FINISHPAGE_LINK_LOCATION "http://127.0.0.1:7777/setup/"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ── Install ─────────────────────────────────────────────────────────────
Section "Install"
    SetOutPath "$TEMP\pan-install"

    ; Extract the PowerShell installer
    File "install.ps1"

    ; Also extract the entire PAN source if bundled
    ; (For online install, install.ps1 downloads everything)
    ; For offline, uncomment:
    ; File /r "..\service\*.*"

    ; Run the PowerShell installer
    DetailPrint "Running PAN installer..."
    nsExec::ExecToLog 'powershell.exe -ExecutionPolicy Bypass -File "$TEMP\pan-install\install.ps1"'
    Pop $0

    ; Clean up
    RMDir /r "$TEMP\pan-install"
SectionEnd

; ── Uninstall ───────────────────────────────────────────────────────────
Section "Uninstall"
    ; Stop PAN
    nsExec::Exec 'taskkill /F /IM node.exe /FI "WINDOWTITLE eq PAN*"'
    nsExec::Exec 'sc stop PAN'
    nsExec::Exec 'sc delete PAN'

    ; Remove shortcuts
    Delete "$DESKTOP\PAN.lnk"
    Delete "$SMPROGRAMS\PAN\PAN.lnk"
    RMDir "$SMPROGRAMS\PAN"
    Delete "$SMSTARTUP\PAN.lnk"

    ; Remove files (but NOT data directory)
    RMDir /r "$LOCALAPPDATA\PAN\node"
    RMDir /r "$LOCALAPPDATA\PAN\service"
    Delete "$LOCALAPPDATA\PAN\PAN.bat"

    ; Ask about data
    MessageBox MB_YESNO "Delete all PAN data (conversations, memory, settings)?" IDNO skip_data
        RMDir /r "$LOCALAPPDATA\PAN\data"
    skip_data:

    ; Remove uninstaller
    Delete "$LOCALAPPDATA\PAN\uninstall.exe"
    RMDir "$LOCALAPPDATA\PAN"
SectionEnd
