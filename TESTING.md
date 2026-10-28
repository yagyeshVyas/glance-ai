# Testing checklist

Before using wshx-host in any environment, verify these behaviors:

## 1. Basic functionality
- [ ] `npm start` launches the overlay
- [ ] Overlay is visible, transparent, rounded glassmorphic design
- [ ] Click ⚙, add API key + base URL, save
- [ ] Type a question in the input box, press Enter
- [ ] Answer streams in, no errors
- [ ] Press Clear, history is wiped
- [ ] Press Copy, answer is in clipboard

## 2. Screenshot + vision
- [ ] Open a web page or document with visible text
- [ ] Ctrl+Alt+Enter (or click "Analyze screen") with empty input — "Analyze screen" click verified 2026-10-24; the global hotkey was not sent (it would fire on the already-running instance)
- [x] Screenshot appears as thumbnail in the overlay — verified 2026-10-24: `#shot` unhidden, `data:image/jpeg`, 1536x864
- [x] Answer describes what's on the screen — verified 2026-10-24 over CDP (clicked "Analyze screen" programmatically), NeuralWatt `deepseek-v4.1-flash`, answered in ~2 s and matched the visible app. The global hotkey path is still unchecked
- [ ] Follow-up questions remember the conversation

## 3. Audio transcription
- [ ] Select "Mic" source
- [ ] Click Listen (or Ctrl+Shift+L)
- [ ] Speak into mic
- [ ] Transcript appears within 7 seconds
- [ ] Click Stop, transcript stops updating
- [ ] Select "System audio", click Listen
- [ ] Play a YouTube video or music
- [ ] System audio is transcribed (if supported by your audio driver)

## 4. Hotkeys

Machine-checkable while the app is running — the overlay does not need to be closed:

```bash
npm run hotkeys              # read-only: which bindings are occupied (exit 3 = held, unproven)
npm run hotkeys -- --toggle  # end-to-end: sends the toggleVisible accelerator, asserts hide → show
npm run hotkeys -- --json    # for a harness
```

Exit codes: `0` ownership proven (toggle flipped the window) · `1` a binding is free · `3` all held but unproven · `2` bad args / no target / probe failed.

`1409` (`ERROR_HOTKEY_ALREADY_REGISTERED`) is global: it says *some* process owns the accelerator, not which one. Only the toggle proves wshx-host owns it, and only `--toggle` can exit 0.

- [x] Ctrl+Shift+H hides and shows the overlay — verified end-to-end 2026-10-25 (`true → false → true`, restored)
- [x] All 11 accelerators registered — verified 2026-10-25, `held=11 free=0`, owner `electron.exe` pid 2768; the earlier "needs your overlay closed" blocker is gone
- [ ] Ctrl+Alt+Space hides and shows the overlay
- [ ] Ctrl+Alt+M toggles click-through (dashed outline appears)
- [ ] Ctrl+Alt+Arrows move the window
- [ ] Ctrl+Alt+Q quits the app

## 5. Stealth verification

What Windows reports, without starting a call (measured 2026-10-25, Windows 11, dev build, running app):

```bash
npm run audit -- --pid <glance-pid>   # affinity + ex-style + verdict for the overlay window
```

- [x] `stealth: true` → `GetWindowDisplayAffinity` = `0x11` (`WDA_EXCLUDEFROMCAPTURE`), verdict `capture-excluded`
- [x] `stealth: false` → the same window reports affinity `none`, verdict `overlay-shaped` only; the switch is wired (`npm run test:main` asserts `setContentProtection`)
- [x] Process identity is visible either way: `electron.exe`, full image path, `Electron / GitHub, Inc.`
- [x] WinRT capture (`scripts/capture-probe.js`, the Windows.Graphics.Capture family Chrome `getDisplayMedia` / Meet / Teams-web use): `stealth: true` → the wshx-host window source returns an **empty 0×0 frame** and WGC logs `GetFrame failed`; `stealth: false` → 728×600, 39% lit. Same window, same probe.
- [x] GDI capture (`scripts/printwindow-probe.ps1`, the `BitBlt`/`PrintWindow` family Zoom links): `stealth: true` → pure black (meanLuma 0.00, 0% lit); `stealth: false` → meanLuma 20.05, 99.96% lit.
- [x] Client capture paths (`scripts/pe-imports.js`, PE import tables + marker strings): Zoom `zVideoUI.dll` links `BitBlt`, `StretchBlt`, `PrintWindow`, `GetWindowDC`, `EnumWindows`, `GetWindowDisplayAffinity`, `SetWindowDisplayAffinity`; Chrome 156 `chrome.dll` references `Windows.Graphics.Capture`, `GraphicsCaptureItem`, `GraphicsCaptureSession`, `IDXGIOutputDuplication`. Teams desktop is not installed on this machine; Meet runs inside Chrome.
- [x] **Exclusion hides pixels, not existence.** Any process can still enumerate the window (`ShellExperienceHost`, `Chrome_WidgetWin_1`, `TOPMOST|LAYERED`, affinity `0x11`) and see `electron.exe` — and Zoom links `GetWindowDisplayAffinity`, so it can read that flag.
- [ ] Start a Zoom/Meet call, share your screen
- [ ] Have the overlay visible on your monitor
- [ ] Record the shared screen or check the preview
- [ ] **If the overlay is visible in the recording, stealth is NOT working.** Check Windows version (needs 10 2004+ or 11), toggle the setting, restart the app.
- [ ] Open Task Manager, look for "wshx-host" or "electron.exe"
- [ ] With the AppUserModelId override on, Task Manager still shows `wshx-host.exe` / `electron.exe` — the setting is a shell/taskbar grouping hint only (see `STEALTH.md` §3)

## 6. Edge cases
- [ ] Disconnect network mid-answer — should error gracefully, not crash
- [ ] Send 10 requests in a row — rate limit retry should handle 429s
- [ ] Ask a question with no API key set — should show "No API key" error
- [ ] Resize the window, restart — position and size are remembered
- [ ] Long conversation (20+ turns) — history is kept, no memory leak
- [ ] Restart the app — previous conversation and transcript are restored
- [ ] Error appears — a "Retry" button shows next to it; click it to re-send
- [ ] Waiting for answer — skeleton shimmer animation shows, not a bare "…"
- [ ] Stay silent while listening — silent chunks are skipped locally, no API calls
- [ ] Kill network mid-stream — watchdog aborts after 30s stall, error + retry shown
- [ ] Provider that ignores `stream: true` — full answer still arrives (non-streaming fallback)

## 7. API compatibility
Test with your chosen provider:
- [ ] OpenAI (gpt-4o-mini + whisper-1)
- [ ] OpenRouter (set base URL, any vision model)
- [ ] Local proxy (LM Studio, text-generation-webui with OpenAI plugin)
- [ ] Azure OpenAI (deployment endpoint, api-version in URL or header)

If transcription fails, check that the provider supports `/audio/transcriptions` with `multipart/form-data`.

## 8. Security
- [ ] API key is never shown in the UI after saving (only •••••• placeholder)
- [ ] API key is not in any log file (`npm start` output)
- [ ] Config file is in `%APPDATA%\wshx-host\config.json` (user-only permissions)

## 9. Wipe + export (0.2.1)
- [ ] Settings → *Wipe all data* → confirm → quit via Ctrl+Alt+Q → `%APPDATA%\wshx-host` is gone after ~10 s
- [ ] Hard-kill by PID: wipe, then `taskkill /F /PID <main-pid>` → directory still removed once the process tree exits
- [ ] Helper-killed variant: wipe, then `taskkill /F /IM wshx-host.exe` (kills app **and** helper) → relaunch the app, quit → directory removed on that session's exit (pending-wipe marker drives it)
- [ ] Helper survives bad `NODE_OPTIONS`: launch the app from a shell with `NODE_OPTIONS=--openssl-legacy-provider` set, wipe, quit → wipe still completes
- [ ] Practice mode: record a session, Stop, Export via the save dialog → `.md` file written
- [ ] Programmatic export: `window.glance.practiceExport({ markdown, filePath })` with a `.md` path **under the OS temp dir** writes the file without a dialog; paths outside temp or without `.md` return an error

## 10. Tamper resistance (packaged build)
Run against `dist/win-unpacked/wshx-host.exe` after `npm run dist`:
- [x] Fuses on — REA `inspect_electron_fuses`: RunAsNode / NODE_OPTIONS / inspect **off**, asar integrity + only-load-from-asar **on** (verified 2026-10-25 on sha256 `2d3a4619…`)
- [x] `--inspect=9333` opens no port
- [x] `ELECTRON_RUN_AS_NODE=1 wshx-host.exe -e "console.log(1)"` prints nothing (runs the app instead)
- [x] `NODE_OPTIONS=--require <script>` is ignored, no injected output
- [x] One flipped byte inside `src/main.js` in `app.asar` → `ASAR Integrity Violation: got a hash mismatch`, exit 1, no window
- [ ] Appending bytes to the end of `app.asar` does **not** trip it (the app boots) — inert data, not a bypass
- [ ] `npm run dist:signed` after electron-builder 26 — not yet re-verified

## 11. Known limitations
- Proctoring tools (Proctorio, Respondus, Honorlock) **will detect** the overlay or the protection flag. Do not use in proctored exams.
- Hardware capture cards, cameras, or DirectX overlays that inspect the DWM chain can still see the window.
- Process inspection tools (Process Explorer, procmon) see the full Electron process tree.

If any of these fail, file an issue or fix it yourself — this is open code.
