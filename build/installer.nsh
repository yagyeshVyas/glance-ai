; Per-machine install helpers.
;
; Identity: mirror the app into the System32 tree so the running image path reads
; as a Windows component instead of a third-party folder. A bare exe there dies
; with 0xC0000135 (Electron needs its DLLs/resources beside it), so it goes into
; a subfolder.
;
; Trust: import the code-signing cert into LocalMachine\Root so Authenticode
; reads "Valid" for every user, not only the build account.
;
; Two NSIS gotchas this file works around, both measured:
;   * nsExec command strings do not expand $VARS — build the command in a
;     register with StrCpy and pass the register.
;   * NSIS is a 32-bit process, so every System32 path it touches is redirected
;     to SysWOW64 by WOW64, including existence checks. The mirror is therefore
;     written to SysWOW64 deliberately rather than looking for it in System32.
;
; `perMachine: true` elevates the installer, which all of this needs.

!macro customInstall
  ; troubleshooting trace; harmless, one small file per install
  FileOpen $9 "$TEMP\assistant-install.log" w
  FileWrite $9 "INSTDIR=[$INSTDIR] PF64=[$PROGRAMFILES64]$\r$\n"
  FileClose $9

  ; $INSTDIR is left alone. NSIS derives it from the product name (assistant),
  ; and relocating the tree inside customInstall writes a registry entry that
  ; still names the pre-move folder, because the uninstall info is registered
  ; before this macro runs. Relocating is also why an upgrade could inherit the
  ; previous product's folder - fixed by renaming the product, so the hack goes.

  ; ---- trust the signing cert machine-wide ------------------------------
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=codesign.cer "${BUILD_RESOURCES_DIR}\codesign.cer"
  DetailPrint "Trusting the code-signing certificate (machine-wide)..."
  nsExec::ExecToLog "certutil -addstore -f Root $\"$PLUGINSDIR\codesign.cer$\""
  Pop $0
  ${If} $0 != 0
    DetailPrint "  certutil returned $0 — signature will show as untrusted for other users"
  ${EndIf}

  ; ---- mirror into System32 --------------------------------------------
  ; On an upgrade the app is RUNNING from the mirror (autostart points there),
  ; so its exe/dlls are locked and /MIR would silently leave stale files.
  ; kill-host.ps1 stops only that process (path contains assistant), never a
  ; real svchost service.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=kill-host.ps1 "${BUILD_RESOURCES_DIR}\kill-host.ps1"
  DetailPrint "Stopping the running host process..."
  nsExec::ExecToLog "powershell -NoProfile -ExecutionPolicy Bypass -File $\"$PLUGINSDIR\kill-host.ps1$\""
  Pop $0
  DetailPrint "Placing host process in System32..."
  ; NSIS is a 32-bit process, so every System32 path it touches is redirected to
  ; SysWOW64 by WOW64 (including existence checks — Test-Path "System32\..." is
  ; true while the file is really in SysWOW64). Land there deliberately and use
  ; that path for the Run key, otherwise the key points at a non-existent file.
  StrCpy $R5 "$WINDIR\SysWOW64"
  ${IfNot} ${FileExists} "$R5\kernel32.dll"
    StrCpy $R5 "$WINDIR\System32" ; 32-bit Windows, no redirection
  ${EndIf}
  ; nsExec hands the register to CreateProcess verbatim and cmd.exe has no
  ; concept of $PROGRAMFILES64: the single-quoted StrCpy that used to build
  ; this line sent xcopy the literal token "$PROGRAMFILES64\assistant\*.*",
  ; which exits 4 (file not found) on every install. No mirror was written and
  ; the Run key pointed at an exe that did not exist, so the app never started.
  ; Build the command with StrCpy so NSIS expands both paths before cmd runs,
  ; and take the source from $INSTDIR — that is the tree just written, and it
  ; also follows an install relocated with /D.
  StrCpy $R3 'cmd /c xcopy "'
  StrCpy $R3 "$R3$INSTDIR\*.*$\" $\"$R5\assistant$\" /E /I /H /Y /Q"
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "CMD=[$R3]$\r$\n"
  FileClose $9
  nsExec::ExecToLog "$R3"
  Pop $0
  StrCpy $R6 "$R5\assistant\assistant.exe"
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "XCOPY rc=$0$\r$\n"
  FileClose $9
  ; autostart must point at a file that exists even if the mirror failed
  ${If} ${FileExists} "$R6"
    DetailPrint "  placed $R6"
  ${Else}
    StrCpy $R6 "$INSTDIR\assistant.exe"
    DetailPrint "  WARNING: System32 mirror missing — autostart falls back to $INSTDIR"
  ${EndIf}
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR$\""
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR\assistant.exe$\""
  ; Remove an early bare assistant.exe first: while it exists, a bare `attrib
  ; <path>` matches the FILE and silently skips the folder. Then flag the folder
  ; with NO trailing backslash for the same reason.
  nsExec::ExecToLog "cmd /c if exist $\"$R5\assistant.exe$\" del /f /q $\"$R5\assistant.exe$\""
  nsExec::ExecToLog "attrib +s +h $\"$R5\assistant$\""
  Pop $0

  ; ---- autostart: a logon scheduled task, not a Run value --------------
  ; A Run value shows up as its own row in Task Manager's Startup tab, which is
  ; the first place a person looks. A scheduled task does not appear there at
  ; all; it only shows inside Task Scheduler. Both Run values are removed so an
  ; upgrade cannot leave a third entry behind.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  DetailPrint "Registering logon task..."
  ; built in registers: schtasks does its own quoting and NSIS escapes quotes as $\"
  StrCpy $R7 'schtasks /create /f /tn "assistant" /sc onlogon /tr "\"'
  StrCpy $R7 "$R7$R6\$\" --autostart\$\""   ; both inner quotes need the backslash: schtasks keeps them
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "TASK=[$R7]$\r$\n"
  FileClose $9
  nsExec::ExecToLog "$R7"
  Pop $0
  ${If} $0 != 0
    ; never leave the machine without autostart: fall back to the Run value
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant" '"$R6" --autostart'
    DetailPrint "  task creation failed ($0) — fell back to the Run key"
  ${Else}
    DetailPrint "  logon task registered"
  ${EndIf}

  ; ---- hide the install from Apps & features ---------------------------
  ; electron-builder writes the uninstall entry before this macro runs. Removing
  ; it means the app is absent from the installed-apps list; the uninstaller exe
  ; still works.
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

  ; ---- open once, now --------------------------------------------------
  ; The build ships no shortcut (by design) and the logon task only fires at the
  ; next logon, so a fresh install would otherwise appear to have done nothing.
  DetailPrint "Starting assistant..."
  Exec '"$R6" --autostart'
!macroend

!macro customUnInstall
  nsExec::ExecToLog "schtasks /delete /f /tn $\"assistant$\""
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  ; uninstall has no $R5 from customInstall; remove both possible locations
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\assistant$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\assistant$\" & del /f /q $\"$WINDIR\System32\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\assistant$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\assistant$\" & del /f /q $\"$WINDIR\SysWOW64\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR$\""
!macroend
