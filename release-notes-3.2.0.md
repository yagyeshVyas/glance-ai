# Glance AI 3.2.0

## The process stops answering

3.1.1 removed the window classes that said Electron. 3.2.0 closes what a
same-user inspector can still read out of the running process — no helper
binary, no driver, no new file on disk. The code is `src/native/stealth.cpp`,
linked into the same `cloak.node` the app already loads, and applied once after
the first window exists (the DACL six seconds later, so Chromium finishes its
own IPC wiring first).

- **ETW** — the five user-mode event writers in `ntdll` (`EtwEventWrite`,
  `EtwEventWriteEx`, `EtwEventWriteFull`, `EtwEventWriteString`,
  `EtwEventWriteTransfer`) return success and emit nothing. Kernel providers
  are written by the kernel and are not touched.
- **PEB** — command line, image path, window title and current directory are
  rewritten as the OS reports them. WMI `Win32_Process.CommandLine` no longer
  shows the app's argv, and the image path reads as the real RuntimeBroker
  location, not the install mirror.
- **Modules** — `chrome_elf.dll`, `ffmpeg.dll`, `libEGL.dll`,
  `libGLESv2.dll`, `vk_swiftshader.dll`, `d3dcompiler_47.dll` and `cloak.node`
  are unlinked from all three PEB loader lists and their name buffers zeroed.
  The code that was already resolved keeps running.
- **Process DACL** — a protected DACL denies `PROCESS_VM_READ`,
  `PROCESS_VM_WRITE`, `PROCESS_CREATE_THREAD` and `PROCESS_DUP_HANDLE` to every
  caller except SYSTEM. `PROCESS_TERMINATE` stays granted, so the app can still
  be closed with Task Manager or `taskkill`.

Measured on Windows 11 26300, Node 24.14, MSVC 2019:

```
PEB image path        C:\Windows\System32\RuntimeBroker.exe
WMI CommandLine       (empty — the provider is denied VM_READ)
EnumProcessModules    0
taskkill /F           SUCCESS (deliberately still granted)
```

## The flag drops in 300 ms, not four seconds

Detector-aware mode still turns the capture flag off and scrambles the text
while a known inspector runs. What changed is how fast it notices: the watch
walks the Toolhelp snapshot in-process (7.6 ms for 290 processes) instead of
spawning `tasklist.exe` every four seconds, and polls at 300 ms. The helper
process no longer appears in the process list every tick.

## Fewer processes from the app itself

Window-title blending used to spawn the helper twice per PID every five
seconds, forever. It now calls `SetWindowTextW` in-process; the helper runs once
per PID, for the capture flag on child surfaces. Per five seconds, that is
eight fewer process creations in a four-process tree.

## Same addon, no new artifact

`binding.gyp` adds `stealth.cpp` to the existing target, `cloak.cpp` registers
the extra exports, and `build-native.js`/`before-pack.js` are unchanged. The
packaged tree still holds exactly one native module per arch.

## Still honest about the rest

- **The `0x11` affinity flag** is still readable by an unknown window inspector
  — now inside a 300 ms window instead of four seconds. Closing it needs a
  signed kernel driver intercepting `NtUserGetWindowDisplayAffinity`, or
  scramble mode with the flag off.
- **The Authenticode signer** is still `CN=Runtime Broker Components` while the version
  resource says Microsoft Corporation. A certificate cannot be forged; the
  choices are a coherent identity, a genuinely signed host process, or
  accepting the tell.
- **Child processes** still carry `--type=renderer` in their command lines, the
  `%TEMP%\dxva_143.exe` helper is still unsigned, and the SysWOW64 mirror path
  is a place no genuine RuntimeBroker lives. Ranked next moves are in
  `HARDENING.md` §4.

Full read-by-read map: [HARDENING.md](HARDENING.md).
