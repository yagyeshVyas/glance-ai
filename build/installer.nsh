; Per-machine install helpers.
;
; Identity: one name on every surface — Glance AI in %ProgramFiles%\GlanceAI\,
; GlanceAI.exe, one Run value ("Glance AI"), one version resource
; (scripts/after-sign.js + src/identity.js), one profile folder. The old build
; mirrored itself into SysWOW64 as RuntimeBroker.exe to read as a Windows
; component; that impersonation is retired, not renamed.
;
; Trust: this installer does NOT modify the operating system's trust store.
; An earlier build imported its self-signed certificate into LocalMachine\Root,
; which made every user trust a key held on a developer's profile. That import
; is removed. The certificate is still removed from machines that ran an older
; build (below); nothing is added.
;
; Legacy: earlier builds shipped as assistant, svchost, "Glance AI" (as a
; SysWOW64 mirror) and RuntimeBroker. Their Run values and scheduled tasks are
; removed here. Their files are NOT deleted by this installer: deleting trees
; under System32/SysWOW64 by name is not something an installer should do.
;
; Two NSIS gotchas this file works around, both measured:
;   * nsExec command strings do not expand $VARS — build the command in a
;     register with StrCpy and pass the register.
;   * NSIS is a 32-bit process, so every System32 path it touches is redirected
;     to SysWOW64 by WOW64, including existence checks.
;
; `perMachine: true` elevates the installer, which the Run key needs.

!macro customInstall
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
  ; the RuntimeBroker-era product certificate is retired too: this build is
  ; signed by Glance AI and must not leave the old publisher trusted
  nsExec::ExecToLog "certutil -delstore Root DFA561EEFC12632EAACDD0C8CBE20F3B23AC5702"
  Pop $0
  nsExec::ExecToLog "certutil -delstore TrustedPeople DFA561EEFC12632EAACDD0C8CBE20F3B23AC5702"
  Pop $0

  ; ---- stop a running copy before replacing files ----------------------
  ; electron-builder's NSIS template already detects a running instance and
  ; offers to close it before this macro runs. Killing by image name here would
  ; also stop an unrelated process that happens to share a legacy name, so the
  ; installer does not do it.

  ; ---- locate the host process (normal Program Files install) ----------
  StrCpy $R6 "$INSTDIR\GlanceAI.exe"
  ${If} ${FileExists} "$R6"
    DetailPrint "  host process at $R6"
  ${Else}
    DetailPrint "  WARNING: $R6 is missing — autostart will fail"
  ${EndIf}

  ; ---- autostart: one Run value, every leftover identity deleted --------
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI"
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "RuntimeBroker"
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
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "Glance AI" '"$R6" --autostart'
  DetailPrint "  autostart registered (Run key)"

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
  ; Only the install tree this product owns is touched. Legacy mirrors under
  ; System32/SysWOW64 are left alone on purpose: an uninstaller that deletes
  ; directories by generic name under the Windows directory is a hazard, not a
  ; cleanup. They are documented for manual removal instead.
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR\GlanceAI.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR\RuntimeBroker.exe$\""
  Pop $0
  nsExec::ExecToLog "attrib -s -h $\"$INSTDIR$\""
!macroend
