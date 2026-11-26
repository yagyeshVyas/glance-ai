# Testing checklist

Before using Glance AI in any environment, verify these behaviors:

## 1. Basic functionality
- [ ] `npm start` launches the overlay
- [ ] Overlay is visible, transparent, rounded glassmorphic design
- [ ] Click ⚙, add API key + base URL, save
- [ ] Type a question in the input box, press Enter
- [ ] Answer streams in, no errors
- [ ] Press Clear, history is wiped
- [ ] Press Copy, answer is in clipboard
- [ ] Set an answer style in Settings, ask again — the shape of the answer changes (bullets really are bullets)

## 2. Screenshot + vision
- [ ] Open a web page or document with visible text
- [ ] Ctrl+Alt+Enter (or click "Analyze screen") with empty input — "Analyze screen" click verified 2026-10-24; the global hotkey was not sent (it would fire on the already-running instance)
- [x] Screenshot appears as thumbnail in the overlay — verified 2026-10-24: `#shot` unhidden, `data:image/jpeg`, 1536x864
- [x] Answer describes what's on the screen — verified 2026-10-24 over CDP (clicked "Analyze screen" programmatically), NeuralWatt `deepseek-v4.1-flash`, answered in ~2 s and matched the visible app. The global hotkey path is still unchecked
- [ ] Follow-up questions remember the conversation

## 3. Audio transcription and consent
- [ ] Fresh profile: click Listen — the consent notice appears and no stream opens until you accept
- [ ] Press Cancel — the notice closes, Listen stays off, no microphone indicator appears in Windows
- [ ] Accept — the red **Listening** pill appears in the header and names the source
- [ ] Select "Mic" source
- [ ] Speak into mic
- [ ] Transcript appears within 7 seconds
- [ ] Click Stop — the transcript stops updating and the red pill disappears
- [ ] Select "System audio", click Listen
- [ ] Play a YouTube video or music
- [ ] System audio is transcribed (if supported by your audio driver)
- [ ] Settings → Withdraw audio consent → Listen asks again
- [ ] Enable captions, restart with consent already given — captions resume without a click; with consent withdrawn, the notice blocks the auto-start and the mode turns itself off

## 4. Hotkeys

Machine-checkable while the app is running — the overlay does not need to be closed:

```bash
npm run hotkeys              # read-only: which bindings are occupied (exit 3 = held, unproven)
npm run hotkeys -- --toggle  # end-to-end: sends the toggleVisible accelerator, asserts hide → show
npm run hotkeys -- --json    # for a harness
```

Exit codes: `0` ownership proven (toggle flipped the window) · `1` a binding is free · `3` all held but unproven · `2` bad args / no target / probe failed.

`1409` (`ERROR_HOTKEY_ALREADY_REGISTERED`) is global: it says *some* process owns the accelerator, not which one. Only the toggle proves Glance AI owns it, and only `--toggle` can exit 0.

- [x] Ctrl+Shift+H hides and shows the overlay — verified end-to-end 2026-10-25 (`true → false → true`, restored)
- [x] All 11 accelerators registered — verified 2026-10-25, `held=11 free=0`, owner `electron.exe` pid 2768; the earlier "needs your overlay closed" blocker is gone
- [ ] Ctrl+Alt+Space hides and shows the overlay
- [ ] Ctrl+Alt+M toggles click-through (dashed outline appears)
- [ ] Ctrl+Alt+Arrows move the window
- [ ] Ctrl+Alt+Q quits the app

## 5. Capture exclusion

The only concealment mechanism is Windows' capture-exclusion flag. There is no
native addon, no window reparenting, no class rename, no DWM cloak, no detector
watch and no scramble mode; `npm run check` fails if one comes back.

```bash
npm run capture-probe                  # capture the panel, report whether its pixels are present
node scripts/capture-ab.js             # same A/B with the setting on and off, exit 1 on failure
npm run audit -- --pid <pid>           # affinity + ex-style + verdict for the window
```

What Windows reports, without starting a call (Windows 11, dev build, running app):
- [x] `stealth: true` → `GetWindowDisplayAffinity` = `0x11` (`WDA_EXCLUDEFROMCAPTURE`), verdict `capture-excluded`
- [x] `stealth: false` → the same window reports affinity `none`, verdict `overlay-shaped` only; the switch is wired (`npm run test:main` asserts `setContentProtection`)
- [x] Process identity is visible either way: `electron.exe`, full image path, `Electron / GitHub, Inc.`
- [x] WinRT capture (`scripts/capture-probe.js`, the Windows.Graphics.Capture family Chrome `getDisplayMedia` / Meet / Teams-web use): `stealth: true` → the window source returns an **empty 0×0 frame** and WGC logs `GetFrame failed`; `stealth: false` → 728×600, 39% lit. Same window, same probe.
- [x] GDI capture (`scripts/printwindow-probe.ps1`, the `BitBlt`/`PrintWindow` family Zoom links): `stealth: true` → pure black (meanLuma 0.00, 0% lit); `stealth: false` → meanLuma 20.05, 99.96% lit.
- [x] Client capture paths (`scripts/pe-imports.js`, PE import tables + marker strings): Zoom `zVideoUI.dll` links `BitBlt`, `StretchBlt`, `PrintWindow`, `GetWindowDC`, `EnumWindows`, `GetWindowDisplayAffinity`, `SetWindowDisplayAffinity`; Chrome 156 `chrome.dll` references `Windows.Graphics.Capture`, `GraphicsCaptureItem`, `GraphicsCaptureSession`, `IDXGIOutputDuplication`.
- [x] **Exclusion hides pixels, not existence.** Any process can still enumerate the window (`ShellExperienceHost`, `Chrome_WidgetWin_1`, `TOPMOST|LAYERED`, affinity `0x11`) and see `electron.exe` — and Zoom links `GetWindowDisplayAffinity`, so it can read that flag.
- [ ] Start a Zoom/Meet call, share your screen
- [ ] Have the overlay visible on your monitor
- [ ] Record the shared screen or check the preview
- [ ] **If the overlay is visible in the recording, exclusion is NOT working.** Check Windows version (needs 10 2004+ or 11), toggle the setting, restart the app.
- [ ] Open Task Manager and confirm the process is `GlanceAI.exe` (installed build) or `electron.exe` (dev)

### 5b. Post-removal regression checks

- [ ] A profile written by an older build opens without ghost-mode keys reappearing in Settings
- [ ] Settings shows only **Hide overlay from screen capture** and **OCR on capture** under capture/privacy
- [ ] `Ctrl+Alt+X` hides the panel from any state, including click-through
- [ ] `npm run check` reports `installer (no trust-store import, no taskkill)` and no `removed-subsystem` failure
- [ ] `npm test` passes 20 helper + 36 main-process + 9 eye-probe assertions

### 5d. New in 3.0.0 — answers

- [ ] Paste two unrelated note blocks into Settings → Knowledge base, ask about one; the answer uses it and ignores the other
- [ ] Set the audio source to *Both*: both loops start, transcript lines are labelled You / Them, and the prompt text itself has no labels
- [ ] Start Zoom or Teams: exactly one notice appears, once per run
- [ ] Ask a question nobody's notes cover; the knowledge section does not appear in the prompt

## 5c. Provider failover
- [ ] Set a backup base URL + key, then break the main one (wrong key) — the status shows the failover notice and the answer still arrives from the backup
- [ ] Remove the backup key and confirm the main provider's error is surfaced instead of a silent hang
- [ ] Confirm the backup key is not sent to the main origin (watch a proxy or the provider's key list)

## 6. Edge cases
- [ ] Disconnect network mid-answer — should error gracefully, not crash
- [ ] Send 10 requests in a row — rate limit retry should handle 429s
- [ ] Ask a question with no API key set — should show "No API key" error
- [ ] Resize the window, restart — position and size are remembered
- [ ] Long conversation (20+ turns) — history is kept, no memory leak
- [ ] Restart the app — previous conversation is restored; the transcript is restored **only** when *Save the live transcript across restarts* is on
- [ ] With transcript saving off, quit and inspect `state.json` — no transcript text is present
- [ ] Turn transcript saving on, talk, restart — the transcript returns; turn it off — the stored copy is deleted immediately
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
- [ ] Config file is in `%APPDATA%\Glance AI\config.json` (user-only permissions)

## 9. Wipe + export (0.2.1)
- [ ] Settings → *Wipe all data* → confirm → quit via Ctrl+Alt+Q → `%APPDATA%\Glance AI` is gone after ~10 s
- [ ] Hard-kill by PID: wipe, then `taskkill /F /PID <main-pid>` → directory still removed once the process tree exits
- [ ] Forced-kill variant: wipe, then `taskkill /F /IM GlanceAI.exe` → relaunch the app, quit → directory removed on that session's exit (pending-wipe marker drives it)
- [ ] Helper survives bad `NODE_OPTIONS`: launch the app from a shell with `NODE_OPTIONS=--openssl-legacy-provider` set, wipe, quit → wipe still completes
- [ ] Practice mode: record a session, Stop, Export via the save dialog → `.md` file written
- [ ] Programmatic export: `window.glance.practiceExport({ markdown, filePath })` with a `.md` path **under the OS temp dir** writes the file without a dialog; paths outside temp or without `.md` return an error

## 10. Tamper resistance (packaged build)
Run against `dist/win-unpacked/GlanceAI.exe` after `npm run dist`:
- [x] Fuses read back from the executable — `npm run verify:build -- --all` checks RunAsNode / NODE_OPTIONS / inspect **off**, asar integrity + only-load-from-asar **on**, and the PE machine type (0x8664 / 0xAA64)
- [x] Packaged launch — `npm run verify:build -- --arch=x64 --launch` starts the app with an isolated profile, waits for its smoke marker, and exits (verified 2026-11-26, 3.4 s)
- [x] `app-update.yml` pins `CN=Glance AI, O=Glance AI, C=US` in both the x64 and arm64 payloads
- [x] Signed installer pipeline - `REQUIRE_SIGNING=1 npm run dist:signed` produced the 3.3.7 x64, arm64 and combined installers, signed and verified each with `signtool verify /pa /all`, and re-stamped `latest.yml` from the signed bytes
- [x] `--inspect=9333` opens no port
- [x] `ELECTRON_RUN_AS_NODE=1 GlanceAI.exe -e "console.log(1)"` prints nothing (runs the app instead)
- [x] `NODE_OPTIONS=--require <script>` is ignored, no injected output
- [x] One flipped byte inside `src/main.js` in `app.asar` → `ASAR Integrity Violation: got a hash mismatch`, exit 1, no window
- [ ] Appending bytes to the end of `app.asar` does **not** trip it (the app boots) — inert data, not a bypass
- [x] `npm run dist:signed` after electron-builder 26 — re-verified 2026-11-26: payload metadata ok, all three installers signed and `signtool verify /pa` ok, `latest.yml` re-stamped

## 10b. Published release (fresh Windows VMs)
`.github/workflows/release-verify.yml`, run against the published `v3.3.7`:
`gh workflow run release-verify.yml -f version=3.3.7 -f previous=3.3.6`
- [x] Clean install of `GlanceAI-3.3.7-x64.exe` on a fresh `windows-latest` VM: installed to `C:\Program Files\GlanceAI`, ProductVersion `3.3.7.0`, signer `CN=Glance AI` (thumbprint `06468B49…AACC`)
- [x] Installed app launches and writes its smoke marker
- [x] 3.3.6 installed, its own updater found the published 3.3.7, downloaded it, and reported `Update 3.3.7 ready — restart to apply`
- [x] Update applied: installed ProductVersion becomes `3.3.7.0`, and the updated `resources\app-update.yml` pins `CN=Glance AI`
- [x] Updated app launches and writes its smoke marker
- [x] arm64 packaged build launched on a `windows-11-arm` runner (smoke marker in 2.1 s)

## 11. Known limitations
- Proctoring tools (Proctorio, Respondus, Honorlock) **will detect** the overlay or the protection flag. Do not use in proctored exams.
- Hardware capture cards, cameras, or DirectX overlays that inspect the DWM chain can still see the window.
- Process inspection tools (Process Explorer, procmon) see the full Electron process tree.

If any of these fail, file an issue or fix it yourself — this is open code.
