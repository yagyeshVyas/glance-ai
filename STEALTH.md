# Advanced stealth & undetectability

wshx-host uses multiple layers to stay invisible:

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
| EnumWindows / FindWindow API | Medium | Title is randomized per launch and frozen (`page-title-updated` prevented); `blendProcessTitles()` (main.js:354) also rewrites the window title to `ShellExperienceHost` every 5 s. Class is still `Chrome_WidgetWin_1` (unpatchable without forking Chromium) |
| `GetWindowDisplayAffinity` | **HIGH** | Returns `0x11` (`WDA_EXCLUDEFROMCAPTURE`) when stealth is on — a direct "this window is hidden from capture" signal. To pass a capture-protected-state detector, turn **scramble** on and **stealth** off: the window is captured normally (affinity `0x0`) and its text is unreadable to any capturer (see §8) |
| Accessibility APIs (UIA, MSAA) | Medium | Chromium a11y disabled in main (`app.accessibilitySupportEnabled = false`); coverage not measured |
| GPU overlay inspection | Low | Not hidden (appears in DWM composition chain) |
| Proctoring tools (Proctorio, Respondus) | **HIGH** | Most detect protected windows or overlays via heuristics — **not safe for exams** |
| Anti-cheat (game) | High | Similar detection as proctoring tools |
| Process list scraping | Low-Medium | Visible as `wshx-host.exe` with `CompanyName=GitHub, Inc.` in the version resource. Window titles are blended to `ShellExperienceHost` (main.js:354) but the on-disk exe name and version resource are unchanged. |

Measured on this machine (dev build, Windows 11 26300) — the numbers a detector gets:

```
window class      Chrome_WidgetWin_1
window title      random hex (per launch) — frozen via page-title-updated + process.title blending to ShellExperienceHost
ex-style          0x80008 = TOPMOST | LAYERED   (no WS_EX_TOOLWINDOW)
display affinity  17 = WDA_EXCLUDEFROMCAPTURE
process           electron.exe (dev) / wshx-host.exe (packaged) — 4 processes each here;
                  the tree size varies by Electron version. Full path + parent PID
                  visible via Toolhelp snapshot
version resource  dev:      FileDescription=Electron        CompanyName=GitHub, Inc.
                  packaged: FileDescription=<package description>  CompanyName=GitHub, Inc.
```

## 5. What you can do to stay safer
- Test in your own Zoom/Meet screen-share before relying on it. Share, then record yourself — if you see the overlay, so does the other side.
- Rename the `.exe` after building (`electron-builder` productName changes app name, but the binary is still recognizable without code signing + obfuscation).
- Run it only when you control the environment. Using it in proctored exams or interviews is detectable and will get you flagged.
- If a service explicitly bans overlays or "protected content," this app triggers that rule.

## 6. Why "undetectable" is a spectrum, not absolute
No software overlay is truly undetectable. The OS and any process with sufficient privileges can see:
- Window handles (EnumWindows)
- GPU composition (DWM APIs)
- Protected content flags (GetWindowDisplayAffinity)
- Process list (tasklist, wmic, Process Explorer)

wshx-host is invisible to *most casual screen capture* and *most screen-sharing software*. It is **not** invisible to purpose-built anti-cheat, proctoring, or forensic tools. Use accordingly.

## 7. Scramble mode — passing the "protected window" test

`setContentProtection` and any Windows capture-exclusion set `WDA_EXCLUDEFROMCAPTURE` (`0x11`), which a proctor or detector reads as "this window is deliberately hidden from capture". Scramble mode is the alternative: keep the window **capturable normally** (stealth **off**, affinity `0x0`) and make the *content* unreadable instead.

- **How:** Settings → *Scramble text*. Every visible text node keeps its real text in a cache, but the glyphs are re-shuffled ~8×/second (each letter rendered as a random character pair). A capture, screen-share frame, or recording sees a text wall of exactly the right shape and density — OCR and vision models get garbage, while you read the actual answer on the live screen. Copy/clipboard still yields the real text, because that path reads the cached plain string.
- **Trade-off:** the window *is* in the shared frame (you can see the panel is there), and the ex-style/topmost shape is unchanged. It removes the "hidden from capture" signal and the legible-content risk simultaneously; it does not remove the window's visual presence. For maximum cover use scramble + a small, quiet panel, and keep stealth off.
- **Combined recipe for the detection test case** (pass = "protected state, no 0x11 flag"): `scramble: on`, `stealth: off`. The detector sees an ordinary topmost window with `display affinity 0x0` and no meaningful title — and nothing legible inside it.

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
