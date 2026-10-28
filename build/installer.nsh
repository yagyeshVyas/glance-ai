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
  FileOpen $9 "$TEMP\glance-install.log" w
  FileWrite $9 "INSTDIR=[$INSTDIR] PF64=[$PROGRAMFILES64]$\r$\n"
  FileClose $9

  ; NSIS derives $INSTDIR from the executable name, and on an upgrade it can
  ; inherit the previous product's folder. Force it to this product's own path
  ; and move the already-extracted files there, so the install location always
  ; matches the name users are told.
  ${If} $INSTDIR != "$PROGRAMFILES64\Glance AI"
    DetailPrint "Moving install to $PROGRAMFILES64\Glance AI..."
    ; Use NSIS's own CopyFiles, not robocopy: robocopy run from inside the
    ; installer returns 16 (access denied) on the destination even when the
    ; same command works from an elevated shell, and CopyFiles is native.
    ; CopyFiles also does not create the destination, so make it first.
    CreateDirectory "$PROGRAMFILES64\Glance AI"
    StrCpy $R1 0
    ${Do}
      CopyFiles /SILENT "$INSTDIR\*.*" "$PROGRAMFILES64\Glance AI"
      ${If} ${FileExists} "$PROGRAMFILES64\Glance AI\Glance AI.exe"
        ${Break}
      ${EndIf}
      IntOp $R1 $R1 + 1
      Sleep 900
    ${LoopUntil} $R1 >= 8
    ${If} ${FileExists} "$PROGRAMFILES64\Glance AI\Glance AI.exe"
      ; resources/locales are subfolders; copy them explicitly then drop the old dir
      CopyFiles /SILENT "$INSTDIR\locales\*.*" "$PROGRAMFILES64\Glance AI\locales"
      CopyFiles /SILENT "$INSTDIR\resources\*.*" "$PROGRAMFILES64\Glance AI\resources"
      nsExec::ExecToLog "cmd /c rd /s /q $\"$INSTDIR$\""
      Pop $0
      StrCpy $INSTDIR "$PROGRAMFILES64\Glance AI"
    ${EndIf}
    FileOpen $9 "$TEMP\glance-install.log" a
    FileWrite $9 "COPY attempts=$R1$\r$\n"
    FileClose $9
  ${EndIf}

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
  ; kill-host.ps1 stops only that process (path contains GlanceAI), never a
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
  StrCpy $R3 'cmd /c xcopy "$PROGRAMFILES64\Glance AI\*.*" "$R5\GlanceAI\" /E /I /H /Y /Q'
  FileOpen $9 "$TEMP\glance-install.log" a
  FileWrite $9 "CMD=[$R3]$\r$\n"
  FileClose $9
  nsExec::ExecToLog "$R3"
  Pop $0
  StrCpy $R6 "$R5\GlanceAI\Glance AI.exe"
  FileOpen $9 "$TEMP\glance-install.log" a
  FileWrite $9 "XCOPY rc=$0 sysdir=[$SYSDIR]$\r$\n"
  FileClose $9
  ${If} ${FileExists} "$R5\GlanceAI\Glance AI.exe"
    DetailPrint "  placed $R5\GlanceAI\Glance AI.exe"
  ${Else}
    DetailPrint "  WARNING: System32 mirror missing — app will run from $INSTDIR"
  ${EndIf}
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR$\""
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR\Glance AI.exe$\""
  ; Remove an early bare GlanceAI.exe first: while it exists, a bare `attrib
  ; <path>` matches the FILE and silently skips the folder. Then flag the folder
  ; with NO trailing backslash for the same reason.
  nsExec::ExecToLog "cmd /c if exist $\"$R5\GlanceAI.exe$\" del /f /q $\"$R5\GlanceAI.exe$\""
  nsExec::ExecToLog "attrib +s +h $\"$R5\GlanceAI$\""
  Pop $0

  ; ---- autostart points at the System32 copy ---------------------------
  ; "Glance AI" is the current value name; the old "svchost" value is removed
  ; so an upgrade cannot leave two autostart entries.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI" '"$R6" --autostart'
!macroend

!macro customUnInstall
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  ; uninstall has no $R5 from customInstall; remove both possible locations
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\GlanceAI$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\GlanceAI$\" & del /f /q $\"$WINDIR\System32\GlanceAI.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\GlanceAI$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\GlanceAI$\" & del /f /q $\"$WINDIR\SysWOW64\GlanceAI.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR\Glance AI.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR$\""
!macroend
