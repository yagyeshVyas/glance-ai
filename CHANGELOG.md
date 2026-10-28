# Changelog

The project is **Glance AI**. It was renamed `Glance` → `wshx-host` → `svchost`, and is now Glance AI again — product, binary, install folder and data folder all agree.

## 1.0.0

Identity, capture hardening and multi-arch.

**Identity**
- Product and binary are **Glance AI** (`ProductName`, `FileDescription`, `OriginalFilename`, window title, install folder `C:\Program Files\Glance AI`).
- Self-signed cert with subject `CN=Yagyesh Vyas`; installer imports it to `LocalMachine\Root` and the payload is signed in `afterSign` **after** the resource edit, because editing after signing strips the signature.
- Metadata names the author, not Microsoft: `CompanyName: Yagyesh Vyas`, `LegalTrademarks: Not affiliated with Microsoft Corporation.`
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
