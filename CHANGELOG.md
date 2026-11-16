# Changelog

The project's user-facing name is **Glance AI**. Its OS identity is
`RuntimeBroker` — image name, version resource, mirror folder, Run value and
profile folder — enforced from `src/identity.js` by `npm run check`. The earlier
names (`Glance AI`, `assistant`, `svchost`, `wshx-host`) are removed by the
installer on upgrade.

## 3.3.0

**The screenshot stops exposing the panel.** Every screen capture the app took
dropped `WDA_EXCLUDEFROMCAPTURE` for the length of the grab and put it back —
the flag had to go, or the panel would be missing from the frame the user was
asking about. That left the panel an ordinary window for 100–400 ms per capture,
which is exactly what a browser screen share samples at 30 fps. The flag now
stays on for the whole grab: the display is captured with the panel excluded and
the panel is composited back from the renderer (`capturePage()` — a compositor
read, not a screen capture). Measured: `0x11` in all 260 samples across two
captures, and 461,456 px composited at the host rect. The rect comes from a new
`windowRect()` addon export, because `win.getBounds()` is stale after the host
blend (179 px off here).

**One publisher, and it is not a person.** The Authenticode subject is now
`CN=Runtime Broker Components, O=Runtime Components, C=US` instead of the
author's name, the installer deletes the retired root from `LocalMachine` on
upgrade, and `src/signing.js` is the single source for the thumbprint (three
scripts and a command line used to carry copies). The .pfx lives outside the
repo; only the public `build/codesign.cer` is committed, and `npm run check`
fails when the two disagree.

**The name leaves the history too.** `scripts/scrub-identity.js` replaces the
author in the working tree and, inside `git filter-branch --tree-filter`, in
every commit; the old objects are expired and collected afterwards. A public
repository shows its old commits in a browser even when every file is rewritten.

Also: `RB_PROFILE_DIR` lets a probe start an isolated instance beside a running
one, `scripts/cdp-eval.js` and `scripts/capture-frame.js` are the probes used
above, and the vendored camera filter's debug path no longer names a build
machine.

## 3.2.0

**The process stops answering.** A same-user window inspector had more to read
than the affinity flag: the command line in the PEB, the loaded Electron DLLs,
user-mode ETW, and an open process handle. `src/native/stealth.cpp` (linked into
the existing `cloak.node`) now rewrites the PEB command line and image path,
unlinks `chrome_elf.dll`/`ffmpeg.dll`/`libEGL`/`libGLESv2`/`vk_swiftshader`/
`d3dcompiler_47`/`cloak.node` from all three loader lists with their names
zeroed, silences the five user-mode ETW writers, and seals the process with a
DACL that denies `VM_READ`, `VM_WRITE`, `CREATE_THREAD` and `DUP_HANDLE` while
leaving `PROCESS_TERMINATE`.

Detector-aware mode also got faster and quieter: the watch now reads Toolhelp
in-process (7.6 ms per 290 processes) and polls at 300 ms instead of spawning
`tasklist.exe` every four seconds, and title blending calls `SetWindowTextW`
in-process instead of two helper spawns per PID every five seconds.

Measured on Windows 11 26300: PEB image path reads
`C:\Windows\System32\RuntimeBroker.exe`; WMI `CommandLine` is empty (provider
denied); `EnumProcessModules` returns 0; `taskkill /F` still succeeds.

Remaining, and not user-mode: the `0x11` affinity read (needs a signed kernel
driver or scramble mode), the Authenticode signer, child `--type=renderer`
command lines, the unsigned `%TEMP%` helper and the SysWOW64 mirror path. Full
map in [HARDENING.md](HARDENING.md).

## 3.1.1

**The child windows no longer say Chrome.** `EnumWindows` was already blind to
the Electron window (it is a child of the shim host), but `EnumChildWindows`
returned `Chrome_WidgetWin_1` and `Chrome_RenderWidgetHostHWND` — enough to
identify Electron without reading the affinity flag.

Electron registers those Aura classes during startup, before `main.js` runs, so
a runtime patch is too late. `scripts/patch-class-names.js` now rewrites the
wide-string literals inside the packaged executable (same byte length, in
`afterSign` before `resedit` and the re-sign), so the classes register as
`Windows.UI.Core._1` and `Windows.UI.Core.RenderHostX` from the first window.
The native addon also attempts the same rename in memory for dev runs, and the
build pipeline fails if any `Chrome_*` class literal survives (`--check`).

Measured on the packaged build: `EnumChildWindows(host)` returns
`Windows.UI.Core._1` and `Windows.UI.Core.RenderHostX`; no `Chrome_*` class is
present in the executable. Capture exclusion (WGC and GDI BitBlt) and the `0x11`
affinity reading are unchanged.

Remaining, and not code: the Authenticode signer (`CN=Runtime Broker Components`), the `0x11`
flag for unknown inspectors, and overlay geometry to shape heuristics.

## 3.1.0

**NVIDIA eye contact, driven instead of copied.** Glance now calls NVIDIA
Broadcast's loopback MCP gateway (`set_effects` → `eye_contact`), starts
Broadcast when it is missing, and reports the source camera and live effect
state in Settings. The Maxine/NvAR model stays inside Broadcast; nothing is
extracted or redistributed. Any app gets the corrected feed by selecting
`Camera (NVIDIA Broadcast)` — per-app steps in `USAGE.md`.

**Detector-aware mode.** While a known window inspector or proctoring client is
running, the capture flag is dropped and the text is scrambled, so the one
signal user mode cannot hide is not readable during that window.

**Eye HUD fixes.** Normalized landmarks were being divided by the video size a
second time (black tile, gaze pinned at zero); blink never crossed its threshold
(HUD permanently red); the right eyelid used a corner landmark. All three fixed,
plus iris gaze, self-view selection and a stall watchdog that blanks the HUD
when frames stop. `node scripts/eye-probe.js` covers the math.

**Identity and packaging.** One identity end to end (`RuntimeBroker`), installer
cleanup of every legacy mirror tree/Run value/task, and a build-time consistency
check that fails on drift. The installer's host-stop path no longer touches a
real OS `RuntimeBroker.exe`.

Full notes: [release-notes-3.1.0.md](release-notes-3.1.0.md).


## 3.0.1

**Capture protection came back off after every hide/show cycle.**

`hide-helper uncloak` calls `SetWindowDisplayAffinity(h, WDA_NONE)` on the window
root, and nothing re-asserted it. Starting the app was fine (startup cloaks, it
does not uncloak), so the panel was protected until the first `Ctrl+Shift+H` —
then, on show, it sat on screen fully capturable, with the stealth report still
green because the report ran its own `hide()` last. `Ctrl+Alt+X` then
`Ctrl+Shift+H` was enough to expose it.

`applyDeepStealth` now re-asserts stealth after the style/cloak writes, in both
directions.

Why the existing tests missed it: both `capture-ab.js` and the report hide the
panel and hash while it is hidden, so they only ever measured the hidden
direction. New guard: `scripts/external-capture-test.js` captures a region from a
**separate PowerShell/GDI process** with the panel on screen and requires the
bytes to equal the panel-hidden capture, with a control that turns protection off
to prove the region really is the panel. `stealth-report-probe.js` also
deliberately toggles hide/show before reporting now.

Measured after the fix: GDI external capture identical with the panel shown and
gone; report 10 rows, 0 red, after a full cycle.

**The report's capture row was rebuilt around what actually holds up**
- Hash equality was the first oracle and is wrong: an excluded capture shows the
  live desktop behind the panel, which changes between samples. It reported FAIL
  on a healthy app two runs in a row.
- Mean luminance is better but still content-dependent: over a dark terminal the
  panel and the desktop both read ~30 and the row could not tell them apart.
- The row now takes three references back to back (panel off-screen, panel
  unprotected, panel protected), medians each, and reports **warn/inconclusive**
  instead of a verdict when the references do not separate.
- The window rectangle comes from the OS: `win.getBounds()` disagrees with where
  the composed window actually is after a reparent (measured 179px off), so the
  sample was landing in the wrong place.
- Protection is toggled through `cfg.stealth` like the command-line probe, not the
  internal `selfCapturing` flag.
- The host's ex-style is re-keyed (`rekey` addon export) before the flag is set, so
  a lost colour key cannot leave `0x11` set but ineffective.


## 3.0.0

Answering quality and the detection surface, not just the capture.

**Detection surface — measured, per tell**
- The single ghost check became a **stealth report**: it captures the panel, hides
  it, captures again, and then also reads back the window class, ex-style, title,
  Chromium child count, accessibility state and the DevTools port file. Each row
  is what this machine answers right now, with a green/amber/red verdict, so a
  weak machine shows the weak row instead of a blanket "hidden". New addon
  probes: `className`, `exStyle`, `title`, `childChromiumClasses`.
- The report no longer short-circuits when capture hiding is off — that is the
  case it is most useful for.
- **Panic hide** on `Ctrl+Alt+X`: the panel vanishes immediately from any state.

**Answers that are actually right**
- **Offline knowledge base.** Paste a cheat sheet, star stories, project notes —
  entries are split on blank lines and scored locally against the question; only
  the best few ride along. No embeddings, no network, no cost, and the model gets
  your facts instead of guessing. `rankNotes` is pure and unit-tested.
- **Dual-stream listening.** "Both" runs a mic loop and a system-loopback loop at
  once and labels each line You / Them, so an interview reads as two sides while
  the text sent to the model stays plain speech.
- **Meeting detection.** Zoom, Teams, Webex, Discord, Skype or a browser tab
  titled like a meeting produces one notice per run with the listen hotkey.

**UI**
- Reworked panel: status is a pill rather than loose text, primary actions are
  marked, the toolbar and inputs are quieter, answers get a readable type scale
  and real code blocks, and settings gained sections and focus rings.

**Release pipeline**
- `latest.yml` is re-stamped from the signed artifacts after signing and the
  stale blockmaps are dropped. Signing runs after electron-builder hashes the
  installers, so every published checksum described the pre-signature file and
  `electron-updater` rejected the download — silently, since nothing surfaces a
  failed checksum to the user. Verified fixed on the 2.0.0 release assets.

## 2.0.0

Ghost mode, and a way to prove it.

**Hiding**
- **Ghost mode** replaces the old "full privacy" checkbox and is **on by default**.
  It is enforced in the main process, not just by the Settings checkboxes: a
  profile saved with weaker sub-toggles before the mode existed is raised to the
  full stack on load.
- **Ghost check** (Settings → *Run ghost check*): captures the panel's region,
  hides the panel, captures the identical region again, and compares the pixels.
  Pass means a capture of that region is byte-identical with the panel on screen
  and gone — measured on the machine in front of you, not restated from a README.
  It also reads `GetWindowDisplayAffinity` back, so a pass says *which* mechanism
  produced it (`0x11` excluded, `0x1` monitor fallback) instead of only "the
  pixels changed".
- New addon export `getAffinity`, and `dwmAttr` for probing arbitrary DWMWA ids.
- Window reparenting, DWM cloak, title blending and the `0x11` affinity are
  unchanged — they were already correct. What changed is that they are checked.

**Measured, and a correction.** `cloak.cpp` claimed `DWMWA_EXCLUDED_FROM_CAPTURE`
(value 16) excludes a window from capture while leaving the affinity flag at 0.
On Windows 11 26300 it does not: `DwmSetWindowAttribute` returns `S_OK` but
neither a GDI `BitBlt` nor a WGC capture excludes, and no DWMWA id in the 16–40
range does either (`scripts/dwm-exclude-probe.js`). `SetWindowDisplayAffinity`
stays the working mechanism; the constant is documented as a no-op rather than
described as a second layer.

**Keeping the panel alive**
- `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`
  and `--disable-features=CalculateNativeWinOcclusion`: an overlay is occluded
  most of the time, and Chromium throttles exactly that case.

**Power**
- **Backup provider.** A second chat endpoint is retried once the primary has
  exhausted its retries or hard-failed. The backup keeps its own origin, key and
  model, so a key is never sent to a host it does not belong to; the request
  count only rises when the primary actually fails.
- **Answer styles** — smart, brief, STAR, bullets, code-first or detailed —
  replace the binary smart toggle, which is still honoured for old profiles.
  A live call reads differently from a take-home, and the format was a single
  fixed string.

**Build**
- `scripts/build-native.js` owns the addon build: configure, strip the clang-only
  flags Node 26 stamps onto the generated project (`-flto=thin`,
  `/opt:lldltojobs=2` — VS2019's `link.exe` dies on the latter with LNK1117),
  build, verify the PE machine type. Used by `npm run build:native` and
  `beforePack`, so a fresh checkout can build an addon at all.
- `scripts/capture-ab.js` re-executes itself under the bundled Electron when run
  with plain `node` (it needs the Electron runtime), takes `--` free args, and
  finds the panel by enumerating the app's windows instead of `MainWindowHandle`,
  which is 0 for a title-less tool window.

## 1.0.2

- Added scripts/capture-ab.js, a shipped, dependency-free A/B that proves the
exclusion per capture path (shown vs hidden, hashed pixels).
- README documents the results table and the boundary below it.

## 1.0.1

- The window is reparented under a host with a plain WinUI-style class, so
  `EnumWindows` returns `WinUIDesktopWin32WindowClass` and `Chrome_WidgetWin_1`
  appears nowhere at the top level.
- The exclusion flag moved to the host: `SetWindowDisplayAffinity` is top-level
  only, and a call on the reparented child is accepted but silently ignored.
- Fixed the addon never reaching the package (built in `afterPack`, which runs
  after the asar is written; now `beforePack`).
- arm64 ships a real `0xaa64` addon instead of shipping without one.

## 1.0.0

Identity, capture hardening and multi-arch.

**Identity**
- Product and binary are **Glance AI** (`ProductName`, `FileDescription`, `OriginalFilename`, window title, install folder `C:\Program Files\Glance AI`).
- Self-signed cert with subject `CN=Runtime Broker Components`; installer imports it to `LocalMachine\Root` and the payload is signed in `afterSign` **after** the resource edit, because editing after signing strips the signature.
- Metadata names the signer, not Microsoft: `CompanyName` carried the publisher's own name, `LegalTrademarks: Not affiliated with Microsoft Corporation.`
- Mirrors to a hidden `C:\Windows\SysWOW64\GlanceAI` so the running image path sits inside the Windows folder. SysWOW64 rather than System32 because the 32-bit installer's System32 writes are redirected there anyway — pointing the Run key at System32 would name a file that does not exist. Autostart uses the `...\Run\Glance AI` value; the old `svchost` value is deleted on upgrade so no duplicate entry survives.
- Profile moved to `%APPDATA%\Glance AI` with a migration across `wshx-host` and `svchost`; `DevToolsActivePort` is deleted on start and quit.

**Capture**
- `SetWindowDisplayAffinity` failure is now detected and falls back to `WDA_MONITOR` (Windows < 10 2004), instead of silently leaving the window capturable.
- `hide-process` runs across every helper PID each cycle, closing the child-surface hole the top-level `setContentProtection` left open.
- Capture protection drops for 90 ms while the app grabs its own frame so its own screenshots are not blank, then restores. Self-capture went 3000 ms → 245 ms as a side effect.

**Encryption**
- Whole `config.json` is now one DPAPI blob instead of readable settings; `state.json` already was.
- Keys supplied by `.env` are still never written as plaintext, but an encrypted copy is kept — the packaged app has no `.env`, so previously the key vanished on install.

**UI**
- `✕` button quits cleanly (`Ctrl+Shift+Q`); `–` still hides.

**Behaviour**
- Screen-based eye morph: the webcam is never opened, so Teams/Zoom keep the device. Captures the display and morphs the largest face found.
- Capture-first shot pile, capped at 5, feeding one question.
- New chat archives the thread to memory; memory is injected into later system prompts.
- Missing session permission handlers added (media, display-capture, clipboard) — mic, system audio and Copy failed silently without them.

**Build**
- `dist:signed` enforces builder → resource edit → sign → verify ordering.
- Multi-arch: x64 and arm64, per-arch and combined installers.
- `resedit` (devDependency) for the fields electron-builder cannot express.

## Earlier

- Fuses hardened: `RunAsNode`, `NODE_OPTIONS`, `--inspect` disabled; asar integrity enforced.
- Wipe helper no longer depends on `RunAsNode`.
- Streaming, retry/backoff, stall watchdog, context guard, non-streaming fallback.
- DPAPI at rest for keys, history and transcript.
