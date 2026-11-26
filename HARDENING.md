# Detection surface — what a user-mode inspector can still read

`STEALTH.md` documents the identity and capture story. This file is the other
half: the complete list of reads a detector on the same machine can make, what
this build answers to each, and which ones **cannot** be closed without kernel
code. The rule underneath it:

- **user-mode detector, same user** → argv, module list, DACL, window title and
  child cmdlines are closed or timed out; the process image name/path, the
  window shape and the display-affinity bit remain readable (structural — see §3
  and vector #8)
- **kernel driver / elevated scanner with `SeDebugPrivilege`** → nothing in user
  mode hides a process image name, a kernel ETW event, or a display-affinity bit

The addon is `src/native/stealth.cpp`, built into the existing `cloak.node` —
one file, no new process, no new artifact on disk.

## 1. What this build changed

| Surface | Read by | Before | Now | Where |
|---|---|---|---|---|
| user-mode ETW writes | any ETW consumer (`EtwEventWrite*`) | emitted | `xor eax,eax; ret` in `ntdll` (5 writers) | `suppressEtw()` |
| PEB command line | WMI `Win32_Process`, `NtQueryInformationProcess`, toolhelp | real argv incl. `--autostart` | `"…\GlanceAI.exe"` (executable only) | `sanitizePeb()` |
| PEB image path | same | image path with profile flags | real `GlanceAI.exe` path | `sanitizePeb()` |
| PEB window title | WMI / console reads | product string | `Glance AI` | `sanitizePeb()` |
| loaded modules | `EnumProcessModules`, PEB `InLoadOrderModuleList` | `chrome_elf.dll`, `ffmpeg.dll`, `cloak.node` | unlinked from all three loader lists, name buffers zeroed | `hideModules()` |
| process access | `OpenProcess(PROCESS_VM_READ)` | allowed | denied to every caller except SYSTEM; terminate still allowed | `sealProcess()` |
| inspector poll | — | `tasklist.exe` child every 4 s | in-process Toolhelp, **7.6 ms**/tick, 300 ms period | `listProcesses()` |
| child command lines | WMI / Process Explorer remote PEB read | `--type=renderer --user-data-dir=…` on every helper PID | rewritten from the browser process to the real GlanceAI.exe path with no switches, 500 ms watcher | `sanitizeRemotePeb()` |
| title blending | `EnumWindows` + `GetWindowText` | 2 helper spawns per PID per 5 s | in-process `SetWindowTextW`, helper only once per new PID | `blendTitles()` |

Measured on this machine (Windows 11 26300, Node 24.14, MSVC 2019):

```
PEB before        "C:\Program Files\nodejs\node.exe" <script>   modules 37
PEB after         "…\GlanceAI.exe"                               modules 37
WMI CommandLine   (empty — the provider is denied VM_READ)
PowerShell        proc.Modules.Count = 0
taskkill /F       SUCCESS (PROCESS_TERMINATE deliberately granted)
listProcesses     7.6 ms avg over 200 runs, 290 processes
```

`npm run test:main` (25 tests), `scripts/test.js` (20), `scripts/check.js` all
pass with the hardening wired in.

## 2. Every read, and whether it closes

Legend: **closed** = no user-mode read gets the value; **timed** = the value is
readable only in a narrow window; **open** = a same-user detector reads it now.

| # | Vector | API / source | State | Notes |
|---|---|---|---|---|
| 1 | Top-level windows | `EnumWindows`, `FindWindow` | closed | only the shell-class host enumerates; the Electron window is a child |
| 2 | Child window classes | `EnumChildWindows` + `GetClassName` | closed | literals patched in memory before `RegisterClass` (`Windows.UI.Core.W…`) |
| 3 | Window title | `GetWindowText`, taskbar | closed | `Settings` everywhere, host untitled |
| 4 | Display affinity | `GetWindowDisplayAffinity` | **open (structural)** | `0x11` while stealth is on; dropped within 300 ms of a known inspector, scrambled meanwhile |
| 5 | DWM cloak | `DwmGetWindowAttribute(DWMWA_CLOAK)` | timed | only cloaked while hidden; a visible panel cannot be cloaked |
| 6 | Window shape | ex-style bits, rect | **open** | `TOPMOST|TOOLWINDOW`, frameless ≥5% screen = "overlay-shaped" by our own audit |
| 7 | Accessibility tree | UIA, MSAA | closed | Chromium a11y disabled; host has no provider |
| 8 | Process name/path | `NtQuerySystemInformation`, toolhelp | **open (structural)** | `GlanceAI.exe` under `%ProgramFiles%\Glance AI\`; no impersonation left to contradict it |
| 9 | Authenticode | `WinVerifyTrust` + signer subject | **open (structural)** | self-signed cert, signer and `CompanyName` both `Glance AI`; only a publicly trusted chain is missing |
| 10 | Version resource | `GetFileVersionInfo` | closed as text | resource agrees with the certificate; nothing is spoofed |
| 11 | Command line | PEB, WMI | closed | rewritten; sealed DACL also blocks the remote read |
| 12 | Module list | `EnumProcessModules`, PEB | closed (main) | second copy of the addon is not re-mapped after unlink |
| 13 | Process DACL | `OpenProcess(VM_READ)` | closed (main) | deny ACE + protected DACL; `SeDebugPrivilege` bypasses it |
| 14 | User-mode ETW | any provider consumer | closed (main) | each Chromium child is its own process and still emits |
| 15 | Kernel ETW | `Microsoft-Windows-Kernel-Process` (image/process events) | **open (kernel)** | events are written by the kernel, not by us |
| 16 | Process image name | `NtQuerySystemInformation` | **open (kernel)** | PID + `GlanceAI.exe` regardless of PEB edits |
| 17 | On-disk tree | filesystem scan | **open** | `%ProgramFiles%\Glance AI\resources\app.asar`, `%APPDATA%\Glance AI` |
| 18 | Autostart | Run key / `schtasks` | **open** | install-time artifact, no runtime fix |
| 19 | Child cmdlines | remote PEB read | closed (user-mode) | every helper PID's command line, image path, window title and cwd rewritten from the browser process; a WOW64 child is refused rather than corrupted. The kernel's process-creation ETW event still carried the real argv at launch (#15) |
| 20 | Temp helper | `%TEMP%\dxva_143.exe` | closed (packaged) | compiled and signed at pack time into `resources\hide-helper.exe`; the first run spawns no compiler. A dev checkout keeps the `%TEMP%` fallback |
| 21 | Capture pixels | WGC / DXGI / GDI | closed while flag on | the flag is the mechanism; see #4 for the trade |
| 22 | GPU composition | DWM inspector | low | no user-mode enumeration API; a DWM-internal reader is out of scope |
| 23 | Network | TLS SNI / proxy logs | **open** | direct calls to the configured API base URL |
| 24 | Camera in use | device arbitration | **open** | the eye HUD holds the camera while listening |
| 25 | Prefetch/Amcache/SRUM | forensic disk read | **open (kernel/admin)** | written by the OS on launch |

## 3. The two structural leases

**The affinity bit.** `WDA_EXCLUDEFROMCAPTURE` is readable by any process for
any window, and it cannot be made a child-window flag — measured in
`STEALTH.md` §11 (flag → reparent → affinity `-1` → capture returns). No
user-mode ordering hides both. The only real closures:

- a kernel driver hooking `NtUserGetWindowDisplayAffinity` (or filtering
  `NtUserBuildHwndList`), which is a signed-driver project with HVCI
  constraints, not a code path in this app; or
- `scramble: on`, `stealth: off` (§7 of STEALTH.md) — no flag, no legible text,
  but the panel is visibly present to a human watching the share.

What this build adds is **time**: 300 ms instead of 4 s between an inspector
appearing and the flag dropping, with the content scrambled in that window.

**The signature.** Authenticode is a signature over the file, not a string.
The RuntimeBroker build carried one permanent tell: `CompanyName=Microsoft
Corporation` next to a certificate whose subject was not Microsoft. This build
removes the mismatch instead of hiding it: the signer is
`CN=Glance AI, O=Glance AI, C=US`, and the version resource says `Glance AI`.
A resource/signer consistency check now passes.

What remains is trust, not naming: the certificate is self-signed, so a detector
that requires a publicly trusted CA or a Microsoft leaf still fails it. The only
user-mode route to a Microsoft-signed leaf is running the payload inside a
genuinely signed Microsoft binary (load/inject into a copy of a signed Windows
executable), which is a different architecture — a native overlay, not an
Electron process tree — and is not what this build is.

Anything that claims a self-signed certificate passes a public-CA check is a
chart drawn over another chart.

## 4. Ordered by detection value, what is worth doing next

1. ~~**Child command lines (#19).**~~ Closed: `stealth.cpp::sanitizeRemotePeb()` writes
   the fake argv into each helper's PEB from the browser process, and
   `sanitizeChildPebs()` in `main.js` patches every new PID within 500 ms. The
   child is our own process, so no injection is needed — only `VM_READ|VM_WRITE|
   VM_OPERATION` on a handle the parent can already open. Measured against the
   sandboxed renderer, GPU and network-utility PIDs (see
   `scripts/child-peb-probe.js`), and against a plain Node child read back
   through WMI (`scripts/remote-peb-probe.js`).
2. ~~**Identity coherence (#9/#10).**~~ Closed by the Glance AI rename: image
   name, install tree, Run value, profile folder, version resource and
   certificate subject all say `Glance AI`. The self-signed trust root remains
   (see §3), but the Microsoft-resource/non-Microsoft-signer mismatch is gone.
3. ~~**Temp helper (#20).**~~ Closed for packaged builds: `scripts/build-hide-helper.js`
   compiles the C# helper during `beforePack`, signs it with the same certificate
   as the app (`build/hide-helper.exe`, `extraResources` → `resources/hide-helper.exe`),
   and `main.js` runs it from the install tree. No `csc.exe` child on first run,
   no unsigned exe in `%TEMP%`. The runtime TEMP path remains only as the dev
   checkout fallback. The compile also needed the `System.Runtime` facade
   reference — without it every WinMD reference failed with CS0012 and the
   helper was never built at all.
4. ~~**Mirror path (#8).**~~ Closed by removing the impersonation: there is no
   `SysWOW64` mirror any more, and the installer deletes the old one on upgrade.
   The image lives in its normal `%ProgramFiles%\Glance AI\` tree.
5. **Window shape (#6).** The host is topmost, frameless and large: exactly the
   overlay heuristic. A caption or a non-topmost window removes the heuristic
   and the product feature at the same time. Worth measuring before changing.
6. **Network (#23).** Route through a local relay with a neutral SNI, or a
   domain front, if the detector watches egress. Not a window problem.

## 5. Build and integrate

```
npm run build:native          # builds cloak.node with stealth.cpp included
node scripts/build-native.js x64   # strips clang-only gyp flags, publishes to src/native/x64/
node scripts/remote-peb-probe.js   # remote PEB write, read back through WMI
node_modules/electron/dist/electron.exe scripts/child-peb-probe.js  # sandboxed renderer/GPU/utility PIDs
npm run test:main             # 25 tests through the real whenReady path
node scripts/test.js          # 20 helper tests
node scripts/check.js         # identity / package drift
```

`main.js` calls `applyProcessHardening()` once after the first window and
`blendProcessTitles()`; `stealth-watch.js` uses `listProcesses()` when the addon
is present and falls back to `tasklist` when it is not. Nothing new is written to
disk by any of it.
