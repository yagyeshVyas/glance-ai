# Advanced stealth & undetectability

Glance AI (installs and runs as `assistant`) uses multiple layers to stay invisible.

**Ghost mode** is the single switch that turns all of them on at its strongest, and
it is on from first run. It is enforced in the main process (`loadConfig`), not just
by the Settings checkboxes.

**Stealth report** (Settings → *Run stealth report*) is how any of this gets
claimed on a given machine. It does the pixel A/B — capture the panel's region,
hide the panel, capture the same region again — and then reads back what a
detector would: window class, ex-style, title, Chromium child count, accessibility
state and the DevTools port file. Every row is a measurement with a
green/amber/red verdict, so the caveats below show up as amber rows on the machine
you are actually on instead of being buried in prose. It costs about two seconds
and it can fail, which is the point.

**Panic hide** (`Ctrl+Alt+X`) drops the panel immediately from any state, because
the moment it matters you are mid-answer and looking at a camera.

## 1. Screen capture protection (`setContentProtection`)
- Windows 10 2004+ `WDA_EXCLUDEFROMCAPTURE` flag
- Blocks: OBS Studio, ShareX, Windows.Graphics.Capture API, most software screen-share in Meet/Zoom/Teams
- **Does NOT block:** hardware capture cards, cameras pointed at screen, GDI BitBlt-based capture (older tools), DirectX overlays that inspect the composition chain

## 2. Window manager stealth
- `skipTaskbar: true` — no taskbar button
- `transparent: true` + rounded glassmorphic design — no opaque window border
- `setAlwaysOnTop(true, 'screen-saver')` — on Windows the level argument is ignored and the window is plain topmost (measured: `WS_EX_TOPMOST`); the level only means something on macOS
- No window shadow (`hasShadow: false`)
- `showInactive()` when toggling visible — does not steal focus or flash

## 3. AppUserModelId override (optional, Settings)
- Calls Electron `app.setAppUserModelId('Microsoft.Windows.ShellExperienceHost')`
- This is a **shell/taskbar grouping** hint. It does **not** rename the process and does **not** change what Task Manager shows — Task Manager's label comes from the executable's version resource, which for an unpackaged build still reads `Electron` / `GitHub, Inc.` (measured).
- One-off probe on Windows 11 26300 (not part of the audit): the explicit AUMID is not readable cross-process — `GetApplicationUserModelId` returns `15703` (`APPMODEL_ERROR_NO_APPLICATION`), and the window property store (`PKEY_AppUserModel_ID`) is empty. Treat the setting as cosmetic.
- **Limitation:** The Electron process tree is still visible via `tasklist`, WMI, and Process Explorer (full image path, parent PID). `blendProcessTitles()` (main.js:354) rewrites the window title of every helper PID to `ShellExperienceHost` every 5 s, which hides the correlation in Task Manager's window column and `EnumWindows` — but the on-disk exe name (`wshx-host.exe`) and version resource (`GitHub, Inc.`) are unchanged.
- Measured on the packaged build: `wshx-host.exe` carries `FileDescription` = the package.json `description` ("Windows shell host.") and `CompanyName` = `GitHub, Inc.` (inherited from Electron — no `author`/company is set in package.json). That string is the name Task Manager and Explorer's Properties dialog show. Only the exe's version resource can change it, not the AUMID.

## 4. Detection vectors NOT yet mitigated
| Vector | Risk | Mitigation status |
|--------|------|-------------------|
| EnumWindows / FindWindow API | Medium | The overlay is reparented under a host window with an innocuous class (`Windows.UI.Core.CoreWindow`), so the Electron window is a child and never enumerates at top level. Title blending rewrites every helper window title to `Settings`. `EnumChildWindows` used to return `Chrome_WidgetWin_1` / `Chrome_RenderWidgetHostHWND`; the build now rewrites those literals inside the packaged executable before signing (`scripts/patch-class-names.js`), so child enumeration returns `Windows.UI.Core._1` / `Windows.UI.Core.RenderHostX`. Verified on the packaged build |
| `GetWindowDisplayAffinity` | **HIGH** | Returns `0x11` (`WDA_EXCLUDEFROMCAPTURE`) on the host when stealth is on — a direct "this window is hidden from capture" signal. To pass a capture-protected-state detector, turn **scramble** on and **stealth** off: the window is captured normally (affinity `0x0`) and its text is unreadable to any capturer (see §7) |
| Accessibility APIs (UIA, MSAA) | Medium | Chromium a11y disabled in main (`app.accessibilitySupportEnabled = false`); coverage not measured |
| GPU overlay inspection | Low | Not hidden (appears in DWM composition chain) |
| Proctoring tools (Proctorio, Respondus) | **HIGH** | Most detect protected windows or overlays via heuristics — **not safe for exams** |
| Anti-cheat (game) | High | Similar detection as proctoring tools |
| Process list scraping | Low-Medium | Visible as `RuntimeBroker.exe` running from `C:\Windows\SysWOW64\RuntimeBroker\` with a Microsoft version resource (§10). That is camouflage, not hiding: a kernel-level enumerator still sees it |

Measured on this machine (packaged build, Windows 11 26300) — the numbers a detector gets:

```
window class      Windows.UI.Core.CoreWindow (host; the Chromium window is a child
                  and never enumerates at top level)
window title      host is untitled; every helper window blends to "Settings"
ex-style          TOPMOST | TOOLWINDOW | LAYERED  (no taskbar, no Alt+Tab)
display affinity  17 = WDA_EXCLUDEFROMCAPTURE
process           RuntimeBroker.exe — four processes (browser + renderer/GPU helpers),
                  all the same name and resource; full path + parent PID via Toolhelp
version resource  FileDescription=Runtime Broker   CompanyName=Microsoft Corporation
                  OriginalFilename=RuntimeBroker.exe
signature         Valid, signer CN=Runtime Broker Components  ← the remaining identity tell
```

The `0x11` cannot be removed. `DWMWA_EXCLUDED_FROM_CAPTURE` looks like the way out —
DWM accepts the attribute with `S_OK` — but on 26300 the window still lands in GDI
and WGC captures, and no DWMWA id from 16 to 40 does better
(`node scripts/dwm-exclude-probe.js` re-checks it per machine). No attribute id,
no affinity flag — the DWM route is a dead end on this build, and the docs that
suggest otherwise were written against a different one.

## 5. What you can do to stay safer
- **Run the ghost check** (Settings → *Run ghost check*) on the machine you will actually use. It captures the panel, hides it, captures again and compares — a claim about your environment, not this file's.
- Test in your own Zoom/Meet screen-share before relying on it. Share, then record yourself — if you see the overlay, so does the other side.
- For a detector that reads the affinity flag, switch to `scramble: on` + `stealth: off` (§7): no flag, and no legible text either.
- The build ships one identity end to end (§10); on an older payload `node scripts/resedit.js <exe>` repairs the version resource.
- Run it only when you control the environment. Using it in proctored exams or interviews is detectable and will get you flagged.
- If a service explicitly bans overlays or "protected content," this app triggers that rule.

## 6. Why "undetectable" is a spectrum, not absolute
No software overlay is truly undetectable. The OS and any process with sufficient privileges can see:
- Window handles (EnumWindows)
- GPU composition (DWM APIs)
- Protected content flags (GetWindowDisplayAffinity)
- Process list (tasklist, wmic, Process Explorer)

Glance AI is invisible to *most casual screen capture* and *most screen-sharing software*. It is **not** invisible to purpose-built anti-cheat, proctoring, or forensic tools. Use accordingly.

## 7. Scramble mode — passing the "protected window" test

`setContentProtection` and any Windows capture-exclusion set `WDA_EXCLUDEFROMCAPTURE` (`0x11`), which a proctor or detector reads as "this window is deliberately hidden from capture". Scramble mode is the alternative: keep the window **capturable normally** (stealth **off**, affinity `0x0`) and make the *content* unreadable instead.

- **How:** Settings → *Scramble text*. Every visible text node keeps its real text in a cache, but the glyphs are re-shuffled ~8×/second (each character replaced by one random character of the same class — letters and digits by alphanumerics, punctuation by punctuation, whitespace preserved). A capture, screen-share frame, or recording sees a text wall of exactly the right shape and density — OCR and vision models get garbage, while you read the actual answer on the live screen. Copy/clipboard and read-aloud still yield the real text: both read `answerRaw`, which the scrambler never touches.
- **Trade-off:** the window *is* in the shared frame (you can see the panel is there), and the ex-style/topmost shape is unchanged. It removes the "hidden from capture" signal and the legible-content risk simultaneously; it does not remove the window's visual presence. For maximum cover use scramble + a small, quiet panel, and keep stealth off.
- **Combined recipe for the detection test case** (pass = "protected state, no 0x11 flag"): `scramble: on`, `stealth: off`. The detector sees an ordinary topmost window with `display affinity 0x0` and no meaningful title — and nothing legible inside it.
- **Caveat:** scramble hides *content*, so it still photographs badly on purpose — a human watching the share sees moving noise, which looks deliberate. It also redraws the answer pane constantly, so it is not the mode to pick if you are reading long code on camera.

## 9. Native stealth helper (`hide-helper.cs`)
Compiled at runtime via in-box `csc.exe` to `%TEMP%\dxva_143.exe` (neutral filename). The source is embedded in `src/embed-helpers.js` so it ships inside the asar. Handles:
- **DWM cloak / uncloak** — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` on the BrowserWindow hwnd + child surfaces; off-screen positioning; `WS_EX_TOOLWINDOW` + `WS_EX_NOACTIVATE` exstyles
- **Window title blending** — `set-title <pid> <name>` via `SetWindowTextW` on the target process's main window
- **chrome_elf.dll hiding** — sets `ATTR_HIDDEN` on `chrome_elf.dll` in the install directory so it doesn't appear in directory listings
- Does **not** change the window class (`Chrome_WidgetWin_1`) — that is registered by Chromium at startup and cannot be changed at runtime

## 8. Audit the detection surface yourself
`npm run audit` (`scripts/detect-audit.js`) runs one read-only probe and prints what a detector sees. Example output — the window list and timings depend on the machine:

```
scanned 14 visible top-level windows, flagged 2 (native probe 23 ms)

PID     PROCESS           AFFINITY                EX-STYLE              TITLE                   VERDICT
2768    electron.exe      WDA_EXCLUDEFROMCAPTURE  TOPMOST|LAYERED       ShellExperienceHost     capture-excluded, overlay-shaped
17568   wshx-host.exe     WDA_EXCLUDEFROMCAPTURE  TOPMOST|LAYERED       ShellExperienceHost     capture-excluded, overlay-shaped
```

- `--all` — every visible top-level window, not only flagged ones
- `--pid <pid>` — restricts the window table to one process (the process-identity section still lists name matches and window owners)
- `--json` — machine-readable, for a detector test harness
- `--fail-on-detect` — exit 1 when anything is flagged **or** a wshx-host/electron process is listed (CI gate; process identity counts, not just window verdicts). The process test is name-based, so any `electron.exe` on the machine counts — stop other Electron apps, or use `--pid`, if you need the gate to isolate one app
- exit 2 means the run is not trustworthy: bad `--pid`, a PID with no visible windows, or a degraded probe (no screen metrics / no process list — typically a service or CI session, which does not see the interactive desktop)
- `--all-procs` — every process with a readable image path, not just name matches and window owners
- `--ps` — force the PowerShell engine (debug)

Verdicts:
- `capture-excluded` — `GetWindowDisplayAffinity` returned `0x11`. This is direct evidence, no heuristic.
- `capture-monitored` — returned `0x1` (`WDA_MONITOR`).
- `overlay-shaped` — frameless (no `WS_CAPTION`, no `WS_THICKFRAME`, not `WS_CHILD`) **and** `WS_EX_TOPMOST` **and** layered or click-through **and** covers ≥5% of the screen. Shell classes (`Shell_TrayWnd`, `Progman`, `WorkerW`, taskbar overflow, IME) are excluded. Does not need `WS_EX_TOOLWINDOW` — wshx-host does not set that bit.

Cost — measured on Windows 11 26300: **probe 20–28 ms.** `./audit` (POSIX shim) and `audit.cmd` ≈ 0.24–0.30 s; `node scripts/detect-audit.js` ≈ 0.25 s; `npm run audit` ≈ 0.8–1.3 s because npm's launcher alone costs ~0.5–1 s on Windows and no flag (`--silent`, `NO_UPDATE_NOTIFIER`) changes that. Use a shim for the fast path.

Build pipeline (`scripts/build-probe.js`):
- the probe is a small C# program, `scripts/detect-audit-probe.cs`, compiled with the in-box .NET Framework `csc.exe` and cached in `%TEMP%\wshx-audit\probe-<hash>.exe`
- cache key = sha256 of the source, so only a source edit recompiles (~0.44 s including signing)
- `npm run check` compiles it as the C# type-check and warms the cache; `npm run probe` does it explicitly; `npm run audit` self-heals (builds on demand if the cache is missing)
- publication never clobbers: a hard link, falling back to `copyFile` with `COPYFILE_EXCL`. `rename` is not used at all — on Windows it silently replaces, which let a concurrent run overwrite a signed build. `WSHX_AUDIT_PUBLISH=copy` forces the fallback so that path is testable on any machine
- signed with the pinned local certificate (`CN=Glance Local`, thumbprint taken from the `dist:signed` script) when signtool and the cert are present; `WSHX_AUDIT_NO_SIGN=1` skips it, `WSHX_AUDIT_REQUIRE_SIGNED=1` refuses a probe that is not signed **by that thumbprint** (`signtool verify /pa /sha1`) and falls back to PowerShell
- the probe is signed **before** publication, so no unsigned build is ever observable; a run that loses the publish race validates the winner rather than returning it unexamined
- the verification result is cached in `<exe>.verified`, keyed by the exe's sha256 **and** the expected thumbprint, so `REQUIRE_SIGNED` pays the signtool check once per build, not on every run. A cache file needs a real PE header (`MZ` + `e_lfanew` → `PE\0\0`) and a marker; anything else is rebuilt, except a file that fails `REQUIRE_SIGNED` (that is a refusal, not damage) or that another run may still be signing
- the compiler is only needed to build, not to run: an existing valid probe works even if `csc.exe` later disappears
- `REQUIRE_SIGNED` is anti-accident, not anti-tamper: anything running as the same user can write both the exe and the marker. The audit is a diagnostic tool, not a trust boundary
- executables are resolved from fixed locations: `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, `%ProgramFiles%\PowerShell\7\pwsh.exe`, the in-box `csc.exe` under `%SystemRoot%`, and `signtool.exe` from Windows Kits before PATH (PATH entries are only accepted under Program Files / Windows). `node_modules/.bin` cannot shadow them
- version resources of processes running from UNC paths are never read (that would open an SMB connection and leak NetNTLM); free-text fields are stripped of control characters and length-capped before printing
- fallback: if `csc.exe` is missing, compilation fails, or security software blocks the freshly compiled exe, the same probe runs through PowerShell — ~0.9–1.2 s, because `powershell.exe` startup alone is ~0.35 s. `--ps` forces that engine. A fallback warning is printed on stderr unless `--json` was given (a forced `--ps` run does not warn); `--json` reports `engine`

Process enumeration uses a Toolhelp snapshot, not WMI. Image paths are resolved for every process, not only suspects (`--all-procs` prints them).

The tool reports. It does not hide anything on the machine — the point is to prove what is visible before you claim otherwise. The only thing it writes is the compiled-probe cache in `%TEMP%` (`WSHX_AUDIT_CACHE` overrides the location).

## 10. Identity: one name on every surface

Every place Windows shows which program is running is a place a person or a
scanner looks: the image name, the PE version resource, the install tree, the Run
value, the scheduled task name, the profile folder, the window title. Earlier
builds disagreed with themselves — package.json said `Glance AI`, the installer
mirrored into `C:\Windows\SysWOW64\Glance AI\`, the PE resource said `assistant`,
and the profile folder was `glance-assistant`. Any one of those identifies the app.

`src/identity.js` is now the only source. `package.json`, `build/installer.nsh`
and `scripts/resedit.js` copy from it, and `npm run check` fails if they drift.

| Surface | Value |
|---|---|
| image name | `RuntimeBroker.exe` |
| version resource | CompanyName `Microsoft Corporation`, FileDescription `Runtime Broker`, InternalName/OriginalFilename `RuntimeBroker.exe` |
| running image path | `C:\Windows\SysWOW64\RuntimeBroker\RuntimeBroker.exe` (mirror, system+hidden) |
| install tree | `%ProgramFiles%\RuntimeBroker\` |
| autostart | HKLM Run value `RuntimeBroker` → mirror exe `--autostart` |
| profile | `%APPDATA%\RuntimeBroker\` (system+hidden) |
| window title | `Settings` |
| Apps & features | no entry (installer deletes the uninstall key) |

Measured readback of the resource edit on a copy of the 3.0.1 payload
(`node scripts/resedit.js <exe>`):

```
CompanyName      : Microsoft Corporation
FileDescription  : Runtime Broker
ProductName      : RuntimeBroker
OriginalFilename : RuntimeBroker.exe
InternalName     : RuntimeBroker.exe
LegalCopyright   : © Microsoft Corporation. All rights reserved.
LegalTrademarks  :
```

Measured after a packaged build and a launch on this machine:

```
process            RuntimeBroker.exe x4, all D:\...\dist\win-unpacked\RuntimeBroker.exe
version resource   Runtime Broker / Microsoft Corporation / RuntimeBroker.exe
signature          Valid, signer CN=Runtime Broker Components
window             WDA_EXCLUDEFROMCAPTURE, TOPMOST|TOOLWINDOW|LAYERED, untitled host
```

What this does not do:

- it does not change the signature (the local `CN=Runtime Broker Components` cert; a
  detector that verifies publisher identity sees a mismatch — that is the
  residual);
- it does not rename files already installed under an old name: the new installer
  removes every legacy mirror tree, Run value and scheduled task on the way in,
  so an upgrade ends with one identity on disk, not two;
- it does not hide the process from a kernel-level enumerator (§11).

## 11. The exclusion flag: measured ceiling

The host carries `WDA_EXCLUDEFROMCAPTURE` (`0x11`) and a detector can read it.
The obvious escape — set the flag while the window is still top-level, then
reparent it into the host so the flagged window becomes a child and disappears
from `EnumWindows` — was measured with `scripts/affinity-reparent-probe.js`
(magenta panel, WGC screen grab through `desktopCapturer`, 1536x864 grab):

| step | affinity | magenta in panel rect |
|---|---|---|
| no flag, top-level | 0 | 98.3% (captured) |
| flag set while top-level | 17 | 0% (excluded) |
| reparented after the flag | **-1** (call fails on a child) | 99.3% (captured again) |
| flag re-issued on the child | -1 | 99.3% (captured) |
| flag on the host (today) | 17 | 0% (excluded) |

Becoming a child drops the flag and the exclusion with it;
`GetWindowDisplayAffinity` fails on child windows by design. So no user-mode
ordering both hides the window from enumeration and keeps it excluded from
capture. The `0x11` read on the host is structural, not a missed call.

Closing it needs a kernel component that intercepts `NtUserGetWindowDisplayAffinity`
(or filters `NtUserBuildHwndList`) — on current Windows that is a signed driver
with HVCI considerations, a separate build rather than a code path in this app.
Until then the user-mode trade is §7: scramble with the flag off passes a flag
reader and shows noise to a human.

## 12. Detector-aware mode: the flag tell, handled

The flag is readable, but only a process that asks for it sees it. §11's ceiling
is a property of the *window*, not of the session: while no window inspector is
running, nothing asks. So the app watches for the processes that do ask and
drops the flag for exactly that window of time:

| detected | mode |
|---|---|
| Process Explorer / Process Hacker / System Informer | flag off, text scrambled |
| Respondus LockDown Browser, RPNow, PSI Secure Browser, Safe Exam Browser, ProctorU/Proctorio/Honorlock/Respondus/Examity/Mettl/Talview helpers | flag off, text scrambled |
| none | flag on, normal content |

`src/stealth-watch.js` scans `tasklist` every 4 s and reports only changes. The
list is image-name exact-ish on purpose: a broad `/guardian/` or `/exam/` match
would flip the panel capturable for unrelated software, which is worse than the
flag. Browsers, OBS, Zoom, Teams and Task Manager are **not** watched — they
capture pixels (already excluded) and never read display affinity.

The transition is invisible in the app: the main process drops
`setContentProtection` + the affinity flag, the renderer turns on the scramble
of §7 and restores the user's own scramble setting when the inspector exits.
Net effect: a flag-reading detector sees an ordinary capturable window with
noise in it; a capture path still receives nothing legible. It does not defeat a
kernel-level scanner, and it does not make the panel invisible to a human
watching the physical screen — those are §11 and the display itself.

Measured on this machine (packaged build, `node scripts/detect-audit.js --pid <pid>`):

```
no inspector              affinity 0x11   capture-excluded, overlay-shaped
procexp64.exe running     affinity none   overlay-shaped
inspector exits           affinity 0x11   capture-excluded, overlay-shaped
```

The panel stays up across all three; only the flag moves. A generic inspector
that is not in `WATCHED` still sees `0x11`, and a fast one can read it inside
the 4 s poll window — the list is the mitigation, not a guarantee.

## 13. Eye HUD: the black tile and the permanent blink

Two bugs in `src/renderer/eye.js`, both in the landmark math, both fixed and
covered by `node scripts/eye-probe.js` (no camera needed):

- MediaPipe Tasks returns **normalized** landmarks. `norm()` divided x and y by
  `videoWidth`/`videoHeight` a second time, so every coordinate shrank by the
  frame size. The face crop became a few pixels in the top-left corner — the
  black HUD — the eye boxes were degenerate, and gaze was pinned at 0.
- Blink divided the lid gap by face height. On this model that ratio never went
  below 0.25, so the state was permanently `blink: true`: red dot, attention
  permanently penalised, and the last frame could sit in the HUD indefinitely.
  Now it is an eye-aspect ratio (lid gap over corner width, threshold 0.16), and
  a 1 Hz watchdog blanks the HUD to standby if frames stop without an `ended`
  event, so a frozen capture cannot leave a thumbnail stuck on screen.
- Gaze now uses the iris ring (points 468–477) when the model returns 478
  points, with the old eye-centre-vs-nose estimate only as a fallback.
- Face selection prefers a face in the right/bottom of the frame (where call
  apps put your self-view) over the largest tile, which is the other party.

## 14. The screenshot no longer lifts the flag

`setContentProtection` excludes the panel from *every* capture, including the
app's own — so `captureScreen()` used to clear the flag, wait 90 ms for DWM to
recomposite, grab, and restore it. The panel was an ordinary capturable window
for 100–400 ms on every screenshot: a browser screen share at 30 fps could
receive it, and a `GetWindowDisplayAffinity` poll during a capture read `0x0`.

Since 3.3.0 the flag stays on for the whole grab. The display comes back without
the panel, the panel's own surface is read from the renderer
(`webContents.capturePage()`, a compositor read that never touches the display),
and the two are alpha-composited at the host window's real rectangle. The model
still gets the panel in the frame; no other capturer ever does.

Measured during two captures, 260 samples at 8 ms:

```
host GetWindowDisplayAffinity   0x11 in every sample
composite                       461,456 px at 408,0 764x604 (unit 1.25)
```

Two details that make it work rather than nearly work:

- **The rect is the host's, from the addon.** `win.getBounds()` is Electron's
  bookkeeping for the child window and goes stale after the blend — measured
  179 px off, which pastes the panel into the wrong place. `windowRect()` on
  `cloak.node` returns `GetWindowRect` of the host.
- **The units are decided per call.** `GetWindowRect` is physical in this
  DPI-aware process and DIP-scaled for a DPI-unaware caller, so the mapping
  picks the unit by comparing the read width against Electron's DIP width (its
  size is reliable even when its position is not).

Three failure modes are handled rather than assumed:

- **An empty compositor read.** `capturePage()` can return a zero-sized surface
  while a window has no frame yet; pasting that would paint a transparent hole,
  so it is retried and, failing that, the frame is left alone.
- **The alpha encoding.** Premultiplied and straight alpha need different
  blends; the buffer is sniffed (no channel may exceed its alpha) instead of
  trusting the decoder.
- **A window capture of the panel itself.** The flag applies to windows exactly
  as it does to a display, so that source is empty too — the page fills the
  window, so the whole frame is the composite.

A failure here is not silent: the trace log gets `composite: <n> px at x,y w×h`,
and `scripts/capture-frame.js` saves the exact JPEG the screenshot path
produced so it can be compared with what is on screen.

## 15. User-mode hardening layer

`HARDENING.md` is the full read-by-read map of every surface a detector can
inspect, including the ones that cannot be closed in user mode. The code for the
closeable half is `src/native/stealth.cpp`, linked into the same `cloak.node`:

- `suppressEtw()` — patches the five user-mode ETW writers in `ntdll`
- `sanitizePeb()` — rewrites command line, image path, window title and current
  directory as the OS reports them for this process
- `hideModules()` — unlinks Electron's loaded DLLs (and `cloak.node`) from all
  three PEB loader lists and zeroes their name buffers
- `sealProcess()` — a protected DACL that denies `VM_READ`, `VM_WRITE`,
  `CREATE_THREAD` and `DUP_HANDLE` to every caller except SYSTEM, while leaving
  `PROCESS_TERMINATE` so the app can still be closed
- `listProcesses()` — in-process Toolhelp scan; `stealth-watch.js` uses it to
  poll at 300 ms instead of spawning `tasklist.exe` every 4 s
- `blendTitles()` — in-process `SetWindowTextW`, replacing the helper spawn per
  PID per five seconds

Applied once from `main.js` after the first window exists; the DACL is applied
six seconds later so Chromium finishes wiring IPC first. The two leases that
remain — the `0x11` display-affinity read and the authenticode signer — are
section 3 of `HARDENING.md`, not things this layer can reach.
