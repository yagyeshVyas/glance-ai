# Using Glance AI

Everything in one place: install, run, the eye features, the NVIDIA camera, and how to make any meeting app show the corrected feed.

---

## Requirements

- Windows 10/11 x64 or arm64.
- Node.js 20+ only for building from source. The one native component, the OCR
  helper, compiles with the in-box .NET Framework compiler; no Visual Studio
  workload is required.
- **Eye contact in calls** uses NVIDIA Broadcast, which requires an NVIDIA RTX GPU (RTX 20-series or newer). Without it, the screen-based eye HUD still works; the virtual camera does not.
- An OpenAI-compatible chat endpoint for answers (any base URL + key).

---

## Install

1. Run the installer from [Releases](https://github.com/yagyeshVyas/glance-ai/releases).
2. It installs per machine to `C:\Program Files\GlanceAI\` and registers autostart. No desktop or Start-menu shortcut is created by design.
3. First launch asks for a base URL and an API key. Keys are encrypted at rest with DPAPI.

The certificate is self-signed, so Windows reports **Unknown publisher**. That is
expected: the installer does not add the certificate to your trust store. If you
choose to trust it, add the public certificate yourself.

---

## Run from source

```powershell
npm install
npm run ocr-helper       # compiles the one native helper (Windows OCR)
npm start                # Electron app
npm test                 # shared + main-process + eye-math tests
npm run check            # syntax, identity, installer and Electron-support checks
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
- **Hide overlay from screen capture** — sets Windows' capture-exclusion flag on the panel.
- **NVIDIA eye contact** — drives NVIDIA Broadcast's eye-contact effect; the status text shows the source camera and whether the effect is live.

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

## Audio consent and the transcript

The first time **Listen** would open a microphone or loopback stream — including
from `Ctrl+Shift+L`, a resumed captions session, or the Listen button — Glance
shows a blocking notice. It names the sources, says that short audio chunks go to
the transcription provider you configured, and asks you to confirm that everyone
in the conversation consents. **Cancel** leaves every stream closed. The agreement
is stored with a timestamp. **Settings → Withdraw audio consent** clears it, and
the next Listen asks again.

While a stream is open, a red **Listening** pill stays visible in the header. It
names the active source (mic, speakers, or both) and changes to **Speaking —
listening paused** while Glance reads an answer aloud, so the indicator always
matches what is actually being captured.

The transcript is **not saved by default**. It stays in memory, is used for
answers, and is erased when Glance quits. To keep it, enable **Settings → Save the
live transcript across restarts**; it is then DPAPI-encrypted in `state.json` like
conversation history. Turning the option off deletes the stored transcript
immediately, and an older profile that still contains one is scrubbed on the first
launch without the opt-in. Practice-mode sessions are a separate, explicit save
that happens only when you press Stop and request the debrief.

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

## Screen-capture exclusion, and its honest limits

- **Capture exclusion** — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`: the panel is absent from screen capture, screen share and recording on Windows 10 2004+ and Windows 11. That is the whole mechanism.
- **Identity** — the packaged binary is `GlanceAI.exe` from `%ProgramFiles%\Glance AI\`, with a matching `Glance AI` version resource and certificate subject; the installer removes every legacy name.
- **What cannot be hidden** — the `0x11` affinity flag while exclusion is on, the window class (`Chrome_WidgetWin_1`), the image name and path in a process list, the overlay's geometry, and any kernel-level enumerator. A purpose-built proctoring tool or EDR agent can find the app.

There is no window reparenting, no window-class rename, no DWM cloak, no detector
watch, no process-memory rewriting and no scramble mode. Those were removed: they
existed to defeat inspection rather than to keep the panel out of a screen share.
The app is hidden from a screen share, not from an instrumented machine, and not
from a phone pointed at the monitor.

---

## Diagnostics

```powershell
npm run audit                                       # what a detector sees
npm run eye                                         # eye math, no camera needed
npm run capture-probe                               # capture the panel, report whether its pixels are there
node scripts/camera-probe.js                        # cameras Chromium can see
node scripts/camera-probe.js --match "NVIDIA" --hold 3   # open a device, report frames
node scripts/broadcast-gateway-probe.js             # Broadcast MCP gateway + effect state
node scripts/broadcast-gateway-probe.js --schemas   # tool schemas
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
| Panel appears in a screen share | Windows older than 10 2004, or the setting is off | Turn on **Hide overlay from screen capture**; upgrade Windows |
| A detector finds the app | The exclusion flag, window class and process name are visible to a same-user process | Expected — exclusion hides pixels, not existence |
| App won't start after an upgrade | Old install still registered | Run the new installer; it removes the legacy mirror, Run value and task |

---

## Third-party notices

- **UnityCapture** — MIT, vendored filter in `vendor/unitycapture`, license included. Used by the experimental virtual-camera path; it is not the NVIDIA route.
- **MediaPipe Face Landmarker** — Apache-2.0, vendored model and WASM in `src/renderer/vendor/mediapipe`.
- **NVIDIA Broadcast** — installed separately by the user; NVIDIA's model and license stay with NVIDIA. Glance only calls Broadcast's loopback MCP gateway.

---

## License

MIT for this repository. See [LICENSE](LICENSE).
