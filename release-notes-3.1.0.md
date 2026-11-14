# Glance AI 3.1.0

## NVIDIA eye contact, built in

- **Settings → NVIDIA eye contact.** Glance now drives NVIDIA Broadcast's own
  eye-contact effect through Broadcast's loopback MCP gateway (`set_effects` →
  `eye_contact`). No NVIDIA model is copied or redistributed: the effect stays
  inside Broadcast, which is the only supported way to use it from another app.
- **Broadcast is started for you.** If it is not running, Glance launches it
  (hidden launch where the build supports it, otherwise a normal launch) and
  waits for its gateway before enabling the effect. One camera app, one feed.
- **Live status in Settings** shows the camera Broadcast is feeding
  (`HD User Facing @ 720p HD`), whether the effect is on, or why it is not.
- **Any meeting app** gets the corrected feed by selecting
  `Camera (NVIDIA Broadcast)`. Step-by-step paths for Chrome, Edge, Firefox,
  Zoom, Teams, Discord, Slack, WhatsApp, the Windows Camera app, OBS and Meet
  are in [USAGE.md](USAGE.md#camera-selection-per-app).

## Detector-aware stealth

- **Window-inspector mode.** While a known window inspector or proctoring client
  is running, the capture-exclusion flag is dropped and the text is scrambled
  instead, so the one signal user mode cannot hide is not readable at that
  moment. Browsers, OBS, Zoom, Teams and Task Manager are deliberately not on
  the watch list — they capture pixels, not flags.

## Eye HUD fixes

- Landmarks are no longer divided by the video size a second time; the face
  crop, eye boxes and gaze vector were collapsing to the top-left corner and
  the HUD looked black.
- Gaze now uses the iris ring (points 468–477) with smoothing, falling back to
  the eye-centre estimate on a 468-point mesh.
- Blink is an eye-aspect ratio instead of lid gap over face height, which never
  crossed the threshold and left the HUD permanently red.
- Face selection prefers a self-view in the right/bottom of the frame over the
  other party's tile.
- A 1 Hz watchdog blanks the HUD to standby when frames stop, so a frozen
  capture cannot leave a thumbnail stuck on screen.
- `node scripts/eye-probe.js` checks the math headlessly.

## Identity and packaging

- One identity end to end: `RuntimeBroker.exe`, a Microsoft version resource,
  the system-tree mirror, the Run value and the profile folder now agree.
  `npm run check` fails the build if package.json, `src/identity.js` and the
  installer drift apart again.
- The installer removes every earlier mirror tree, Run value and scheduled task
  (`Glance AI`, `assistant`, `svchost`, `wshx-host`) on upgrade.
- The installer's host-stop path no longer kills a real OS `RuntimeBroker.exe`:
  it stops only processes inside our own subfolder.

## New diagnostics and probes

- `scripts/camera-probe.js` — what Chromium sees, per-device frame size, motion
  and a saved PNG.
- `scripts/broadcast-gateway-probe.js` — Broadcast MCP gateway, tools, effect
  state, `--schemas`.
- `scripts/affinity-reparent-probe.js` — the measured reason the capture flag
  cannot be moved off the top-level host.
- `scripts/vcam-pattern.js` + `vendor/unitycapture` (MIT) — the experimental
  virtual-camera transport, documented as unfinished.

## Docs

- New [USAGE.md](USAGE.md): install, source build, settings, hotkeys, answers,
  eye HUD, NVIDIA eye contact, per-app camera selection, troubleshooting,
  third-party notices.
- `STEALTH.md` updated with the flag-ceiling measurement, detector-aware mode
  and the identity map.

## Compatibility

Windows 10 2004+ / Windows 11. Eye contact requires NVIDIA Broadcast and an RTX
GPU; the rest of the app runs without it. Auto-update uses this release's
`latest.yml`. Because the OS identity changed to `RuntimeBroker`, an update from
3.0.1 registers the new product and the installer clears the old mirror tree,
Run value and scheduled task on the way in; the old panel is replaced, not
duplicated.
