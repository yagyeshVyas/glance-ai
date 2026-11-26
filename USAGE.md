# Using Glance AI

Everything in one place: install, run, the eye features, the NVIDIA camera, and how to make any meeting app show the corrected feed.

---

## Requirements

- Windows 10/11 x64 or arm64.
- Node.js 20+ and the Visual Studio C++ build tools only for building from source.
- **Eye contact in calls** uses NVIDIA Broadcast, which requires an NVIDIA RTX GPU (RTX 20-series or newer). Without it, the screen-based eye HUD still works; the virtual camera does not.
- An OpenAI-compatible chat endpoint for answers (any base URL + key).

---

## Install

1. Run the installer from [Releases](https://github.com/yagyeshVyas/glance-ai/releases).
2. It installs per machine, mirrors the running app into the system tree, and registers autostart. No desktop or Start-menu shortcut is created by design.
3. First launch asks for a base URL and an API key. Keys are encrypted at rest with DPAPI.

---

## Run from source

```powershell
npm install
npm run build:native     # the native addon (DWM cloak + window shim)
npm start                # Electron app
npm test                 # shared + main-process + eye-math tests
npm run check            # syntax check + identity consistency
```

Packaging:

```powershell
npm run dist:signed      # electron-builder, version-resource edit, signing
```

---

## Settings

Open the gear in the panel header (`Ctrl+Shift+H` shows the panel).

- **Base URL / API key / model** — any OpenAI-compatible provider.
- **OCR on capture** — reads text locally from every screenshot and attaches it to the question.
- **Ghost mode** — forces the strongest privacy settings on (capture exclusion, process blend, deep cloak, eye tracking).
- **NVIDIA eye contact** — drives NVIDIA Broadcast's eye-contact effect; the status text shows the source camera and whether the effect is live.
- **Scramble text** — keeps the window capturable (no `0x11` flag) and shuffles the glyphs instead, for a detector that reads the capture-exclusion flag.
- **Run stealth report** / **Run ghost check** — measures what a detector sees on this machine instead of repeating a claim.

---

## Hotkeys

| Key | Action |
|---|---|
| `Ctrl+Shift+H` / `Ctrl+Alt+Space` | show / hide |
| `Ctrl+Alt+X` | panic hide |
| `Ctrl+Alt+Enter` | ask with a screenshot |
| `Ctrl+Shift+L` | start / stop listening |
| `Ctrl+Shift+S` | capture a shot into the pile |
| `Ctrl+Shift+E` | eye HUD on / off |
| `Ctrl+Shift+A` | "what do I say?" from the transcript |
| `Ctrl+Alt+M` | click-through toggle |
| `Ctrl+Alt+Arrows` | move the panel |
| `Ctrl+Alt+Q` / `Ctrl+Shift+Q` | quit |

---

## Answers

- **Ask** — type a question, or `Ctrl+Alt+Enter` to attach the screen.
- **Listen** — captures system audio (WASAPI loopback) and transcribes it, so questions are answered as they are asked.
- **Transcript** — `Ctrl+Shift+A` answers from what was said.
- **Practice mode** — answers stay hidden until the session ends, then a scored debrief is produced.

---

## Eye HUD (screen-based)

The panel never opens the webcam by default. It reads the screen, finds the face (preferring a self-view in the right/bottom of the frame), and draws a landmark mesh, a gaze vector and an attention score. The HUD shows a small crop of that face; the dot is green when tracking, red on a blink, and the tile goes to standby when no face is in frame.

`Ctrl+Shift+E` toggles it. It is tracking, not morphing: it does not change your outgoing video.

---

## Eye contact in calls (NVIDIA Broadcast)

NVIDIA Broadcast owns the eye-contact model; Glance drives Broadcast's effects API instead of copying it.

1. Install **NVIDIA Broadcast** (free, RTX required) and let it run — Glance starts it automatically when it is not running.
2. In Glance, Settings → **NVIDIA eye contact** on. The row shows the source camera and the live effect state.
3. In every app, choose the camera **`Camera (NVIDIA Broadcast)`** — never `HD User Facing`, which is the raw lens.

Glance's `nvidiaEyeContact` setting turns the effect on at start and whenever the panel is shown. Without Broadcast running there is no effect and no virtual camera.

### Camera selection per app

| App | Path |
|---|---|
| Chrome / Brave / Opera | `chrome://settings/content/camera` → Camera → `Camera (NVIDIA Broadcast)`; or the dropdown in a call's pre-join screen |
| Edge | `edge://settings/content/camera` |
| Firefox | Settings → Privacy & Security → Permissions → Camera → Settings… |
| Zoom | Settings → Video → Camera |
| Teams | Settings → Devices → Camera |
| Discord | User Settings → Voice & Video → Camera |
| Slack | Preferences → Audio & Video → Camera |
| Windows Camera | camera switcher (top-right) |
| WhatsApp Desktop | Settings → Video → Camera |
| OBS | Source → Video Capture Device → Device |
| Google Meet (web) | pre-join dropdown, or in-call ⋮ → Settings → Video |

### Rules that prevent the gray frame

- Broadcast must hold the physical camera exclusively. Close the Windows Camera app, OBS previews, and any browser tab using the camera.
- If an app was opened before Broadcast started, restart it — camera lists are enumerated at startup.
- Do not disable the physical camera in Device Manager; Broadcast needs it as its source.
- If the feed is gray or says "camera in use", something else has the lens; close it and Broadcast recovers on its own.

---

## Stealth, and its honest limits

- **Capture exclusion** — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`: the panel is absent from screen capture, screen share and recording. Measured against WGC and against a separate-process GDI BitBlt: 0 pixels either way.
- **Window shim** — the Electron window is reparented under a host with a plain class; `EnumWindows` returns only the host.
- **Window-class rename** — Chromium's `Chrome_WidgetWin_*` / `Chrome_RenderWidgetHostHWND` literals are rewritten in the packaged executable before signing, so `EnumChildWindows` sees `Windows.UI.Core._1` / `Windows.UI.Core.RenderHostX` instead of Electron's classes.
- **Identity** — the packaged binary is `GlanceAI.exe` from `%ProgramFiles%\Glance AI\`, with a matching `Glance AI` version resource and certificate subject; the installer removes every legacy name, including the old RuntimeBroker mirror.
- **Detector-aware mode** — while a known window inspector or proctoring client runs, the capture flag is dropped and the text is scrambled instead.
- **What cannot be hidden** — the `0x11` affinity flag while exclusion is on (user mode cannot move it; detector-aware mode drops it for known inspectors), the image name and path in a process list, the overlay's geometry to shape heuristics, and any kernel-level enumerator. See `STEALTH.md` for the measurements.

---

## Diagnostics

```powershell
npm run audit                                       # what a detector sees
npm run eye                                         # eye math, no camera needed
node scripts/camera-probe.js                        # cameras Chromium can see
node scripts/camera-probe.js --match "NVIDIA" --hold 3   # open a device, report frames
node scripts/broadcast-gateway-probe.js             # Broadcast MCP gateway + effect state
node scripts/broadcast-gateway-probe.js --schemas   # tool schemas
node scripts/affinity-reparent-probe.js             # capture-exclusion flag experiments
node scripts/vcam-pattern.js --seconds 20           # feed a test pattern to the UnityCapture filter
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Camera (NVIDIA Broadcast)` missing from an app | Broadcast not running, or the app enumerated before it started | Start Glance, wait ~10 s, restart the app |
| Camera shows a gray frame | Another app holds the physical camera | Close Windows Camera / OBS / the browser tab using it |
| Eyes not corrected in a call | The app is using `HD User Facing` | Choose `Camera (NVIDIA Broadcast)` |
| Eye contact row says Broadcast not running | Broadcast closed after boot | Glance relaunches it on next start or show; or open Broadcast once |
| Eye HUD shows standby | No face in the captured screen | Put the call's self-view on the captured display |
| Panel invisible in screen share but a detector flags it | `0x11` is readable by a same-user process | Turn on scramble mode, or accept the limit |
| App won't start after an upgrade | Old install still registered | Run the new installer; it removes the legacy mirror, Run value and task |

---

## Third-party notices

- **UnityCapture** — MIT, vendored filter in `vendor/unitycapture`, license included. Used by the experimental virtual-camera path; it is not the NVIDIA route.
- **MediaPipe Face Landmarker** — Apache-2.0, vendored model and WASM in `src/renderer/vendor/mediapipe`.
- **NVIDIA Broadcast** — installed separately by the user; NVIDIA's model and license stay with NVIDIA. Glance only calls Broadcast's loopback MCP gateway.

---

## License

MIT for this repository. See [LICENSE](LICENSE).
