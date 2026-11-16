' Starts server/glance-api.js with no console window.
'
' Double-click this file (or launch it from a shortcut / the Run key) instead of
' the .cmd: wscript has no console of its own, so nothing flashes on screen and
' nothing stays in the taskbar. The process shows up in Task Manager as node.exe
' and exits with stop-api.cmd.
Option Explicit

Dim fso, shell, here, script, repo

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
script = fso.BuildPath(here, "glance-api.js")
repo = fso.GetParentFolderName(here)

If Not fso.FileExists(script) Then
  MsgBox "glance-api.js is missing next to this launcher.", 16, "Glance API"
  WScript.Quit 1
End If

shell.CurrentDirectory = repo
' 0 = hidden window, False = do not wait
shell.Run "node.exe """ & script & """", 0, False
