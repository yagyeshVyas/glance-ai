# Detection surface — what a user-mode inspector can still read

`STEALTH.md` documents the identity and capture story. This file is the other
half: the complete list of reads a detector on the same machine can make, what
this build answers to each, and which ones **cannot** be closed without kernel
code. The rule underneath it:

- **user-mode detector, same user** → everything below is closed or timed out
  except the two structural leases (§3)
- **kernel driver / elevated scanner with `SeDebugPrivilege`** → nothing in user
  mode hides a process image name, a kernel ETW event, or a display-affinity bit

The addon is `src/native/stealth.cpp`, built into the existing `cloak.node` —
one file, no new process, no new artifact on disk.

## 1. What this build changed

| Surface | Read by | Before | Now | Where |
|---|---|---|---|---|
| user-mode ETW writes | any ETW consumer (`EtwEventWrite*`) | emitted | `xor eax,eax; ret` in `ntdll` (5 writers) | `suppressEtw()` |
| PEB command line | WMI `Win32_Process`, `NtQueryInformationProcess`, toolhelp | real argv incl. `--autostart` | `"C:\Windows\System32\RuntimeBroker.exe"` | `sanitizePeb()` |
| PEB image path | same | `…\SysWOW64\RuntimeBroker\RuntimeBroker.exe` | `C:\Windows\System32\RuntimeBroker.exe` | `sanitizePeb()` |
| PEB window title | WMI / console reads | product string | `Settings` | `sanitizePeb()` |
| loaded modules | `EnumProcessModules`, PEB `InLoadOrderModuleList` | `chrome_elf.dll`, `ffmpeg.dll`, `cloak.node` | unlinked from all three loader lists, name buffers zeroed | `hideModules()` |
| process access | `OpenProcess(PROCESS_VM_READ)` | allowed | denied to every caller except SYSTEM; terminate still allowed | `sealProcess()` |
| inspector poll | — | `tasklist.exe` child every 4 s | in-process Toolhelp, **7.6 ms**/tick, 300 ms period | `listProcesses()` |
| title blending | `EnumWindows` + `GetWindowText` | 2 helper spawns per PID per 5 s | in-process `SetWindowTextW`, helper only once per new PID | `blendTitles()` |

Measured on this machine (Windows 11 26300, Node 24.14, MSVC 2019):

```
PEB before        "C:\Program Files\nodejs\node.exe" <script>   modules 37
PEB after         "C:\Windows\System32\RuntimeBroker.exe"       modules 37
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
| 8 | Process name/path | `NtQuerySystemInformation`, toolhelp | **open (structural)** | `RuntimeBroker.exe`, but the path is the SysWOW64 mirror, not `System32` |
| 9 | Authenticode | `WinVerifyTrust` + signer subject | **open (structural)** | valid chain, signer `CN=Runtime Broker Components` vs `CompanyName=Microsoft Corporation` |
| 10 | Version resource | `GetFileVersionInfo` | closed as text | spoofed to Microsoft's fields; only the signature disagrees |
| 11 | Command line | PEB, WMI | closed | rewritten; sealed DACL also blocks the remote read |
| 12 | Module list | `EnumProcessModules`, PEB | closed (main) | second copy of the addon is not re-mapped after unlink |
| 13 | Process DACL | `OpenProcess(VM_READ)` | closed (main) | deny ACE + protected DACL; `SeDebugPrivilege` bypasses it |
| 14 | User-mode ETW | any provider consumer | closed (main) | each Chromium child is its own process and still emits |
| 15 | Kernel ETW | `Microsoft-Windows-Kernel-Process` (image/process events) | **open (kernel)** | events are written by the kernel, not by us |
| 16 | Process image name | `NtQuerySystemInformation` | **open (kernel)** | PID + `RuntimeBroker.exe` regardless of PEB edits |
| 17 | On-disk tree | filesystem scan | **open** | `%ProgramFiles%\RuntimeBroker\resources\app.asar`, SysWOW64 mirror, `%APPDATA%` |
| 18 | Autostart | Run key / `schtasks` | **open** | install-time artifact, no runtime fix |
| 19 | Child cmdlines | remote PEB read | **open** | `--type=renderer`, `--user-data-dir=…` in 3 helper PIDs |
| 20 | Temp helper | `%TEMP%\dxva_143.exe` | **open** | compiled by `csc.exe` on first run, unsigned |
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
A self-signed cert whose subject says `Microsoft Corporation` fails chain
validation; keeping the real signer succeeds but leaves a signer that is not
Microsoft. The three honest options:

1. **Coherent identity** — set `CompanyName`/`LegalCopyright` to the actual
   signer (or its company), so version resource and certificate agree. Nothing
   passes a "signed by Microsoft" check, but a resource/signer consistency check
   stops flagging a mismatch. Trade: the process no longer blends into
   Microsoft-named lists.
2. **Borrowed signature** — run the payload inside a genuinely signed
   Microsoft binary (load/inject into a copy of `RuntimeBroker.exe` from
   `System32`). Signature and path then verify; this is a different
   architecture (native renderer, no Electron process tree) and is the only
   user-mode route to a passing `WinVerifyTrust` with a Microsoft leaf.
3. **Accept the lease** — assume detectors that check signatures; use the app
   only where the signature is not read.

Anything that claims otherwise is a chart drawn over another chart.

## 4. Ordered by detection value, what is worth doing next

1. **Child command lines (#19).** The three helper PIDs carry
   `--type=renderer --user-data-dir=…`. The main process cannot patch a child's
   PEB without code inside it. Options: a Chromium `--renderer-cmd-prefix`-style
   wrapper that re-execs with a short command line, or a native launcher that
   creates the process suspended and rewrites its PEB before resume. Both are
   real work; the current state is a clear "this is Electron" signal.
2. **Identity coherence (#9/#10).** Decide between §3's options 1 and 2 before
   another release. 3.3.0 removed the person's name from the signature (it is now
   a publisher subject), so what remains is the mismatch itself: Microsoft's name
   on the resource, a non-Microsoft signer on the certificate.
3. **Temp helper (#20).** Compile once at install, sign with the same
   certificate, place it under the install tree instead of `%TEMP%`, and delete
   the `.cs` source. A `csc.exe` spawn on first launch is a process-creation
   event and an unsigned exe on disk.
4. **Mirror path (#8).** `C:\Windows\SysWOW64\RuntimeBroker\` is where no
   genuine Microsoft binary lives. If impersonation is kept, the only
   consistent location is `System32\RuntimeBroker.exe`, which is occupied by
   the real component — that is the argument for option 1 or 2 above, not a
   folder rename.
5. **Window shape (#6).** The host is topmost, frameless and large: exactly the
   overlay heuristic. A caption or a non-topmost window removes the heuristic
   and the product feature at the same time. Worth measuring before changing.
6. **Network (#23).** Route through a local relay with a neutral SNI, or a
   domain front, if the detector watches egress. Not a window problem.

## 5. Build and integrate

```
npm run build:native          # builds cloak.node with stealth.cpp included
node scripts/build-native.js x64   # strips clang-only gyp flags, publishes to src/native/x64/
npm run test:main             # 25 tests through the real whenReady path
node scripts/test.js          # 20 helper tests
node scripts/check.js         # identity / package drift
```

`main.js` calls `applyProcessHardening()` once after the first window and
`blendProcessTitles()`; `stealth-watch.js` uses `listProcesses()` when the addon
is present and falls back to `tasklist` when it is not. Nothing new is written to
disk by any of it.
