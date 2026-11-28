# Changelog

The project's user-facing name is **Glance AI**, and that is now its OS identity
too: image name `GlanceAI.exe`, install tree `%ProgramFiles%\GlanceAI\`,
autostart value `Glance AI`, profile `%APPDATA%\Glance AI`, certificate subject
`CN=Glance AI`. The earlier names (`RuntimeBroker`, `assistant`, `svchost`,
`wshx-host`) are removed by the installer on upgrade; `npm run check` enforces
the current identity from `src/identity.js`.

## 3.4.3

Published 27 Nov 2026. The update verifier actually reads the signature.

- Updates: the verifier now passes the `Get-AuthenticodeSignature` pipeline to
  the shell with the outer quotes electron-updater uses, and starts it through
  `cmd` with `chcp 65001`. Without the quotes, `cmd.exe` consumed the pipeline
  and stdout was empty, so 3.4.1/3.4.2 rejected every downloaded installer on a
  clean machine with "could not read the signature".
- Release verification: the clean-install job runs the thumbprint pin on a VM
  that has not trusted the certificate, against the published installer, and it
  passes. This is the first build whose own verifier is proven on an untrusted
  machine.
- Compatibility: installs from 3.3.7 through 3.4.2 must install 3.4.3 once
  manually. After that, the thumbprint pin verifies future releases without a
  trust-store install. A publicly trusted certificate is still required to
  remove **Unknown publisher**.
- Tests: 56 unit tests, 45 main-process tests, 10 embedding tests, 9 eye checks
  and 3 OCR checks; signed x64/arm64 build and packaged x64 Settings smoke.

## 3.4.2

Published 27 Nov 2026. A follow-up for the update verifier.

- Updates: the verifier parses the signature JSON even when the PowerShell host
  writes a harmless warning to stderr (which a service process with redirected
  handles can do). Treating any stderr as fatal turned a valid pinned signature
  into a failed update. The console-encoding assignment that caused the warning
  is removed; a BOM is still stripped before parsing.
- Release verification: the clean-install job runs the thumbprint pin on a VM
  that has not trusted the certificate, and the 3.4.1 → 3.4.2 update runs with
  no trust import, so the app's own verifier - not electron-updater's default -
  accepts the downloaded installer.
- Compatibility: installs from 3.3.7 or 3.4.0 still use the default verifier and
  need the certificate trusted; install 3.4.2 once manually. A publicly trusted
  certificate is still required to remove **Unknown publisher**.
- Tests: 56 unit tests, 45 main-process tests, 10 embedding tests, 9 eye checks
  and 3 OCR checks; signed x64/arm64 build and packaged x64 Settings smoke.

## 3.4.1

Published 27 Nov 2026. A patch for the update path itself.

- Updates: the downloaded installer is verified against the project
  certificate's SHA-1 thumbprint instead of requiring the self-signed
  certificate to be in a Windows trust store. The signature must be
  cryptographically intact (`Valid`, or `UnknownError` for an untrusted root);
  `NotSigned`, `HashMismatch` and `NotTrusted` are rejected, and so is any other
  signer. A tampered file cannot reach the thumbprint comparison. This removes
  the trust-store dependency that made 3.3.7 → 3.4.0 fail on a clean VM.
- Updates: all updater events pass through one reducer, so a background check
  that finishes after a download can no longer turn "ready" back into
  "available" or replace a progress line. A check is refused while a download
  is moving, and install is refused until a version is actually downloaded.
- Release verification: the clean-install VM checks the thumbprint pin with the
  certificate deliberately untrusted, and the 3.3.7/3.4.0 update job waits for
  the app's one boot check instead of starting a second one. The ephemeral
  update VM imports the public certificate only so the previous version's
  default verifier can reach the DN pin; the product does not install it.
- Compatibility: installs from 3.3.7 or 3.4.0 use electron-updater's default
  verifier, which needs the certificate trusted. Those machines must install
  3.4.1 once manually; after that, updates use the thumbprint pin. A publicly
  trusted certificate is still required to remove **Unknown publisher**.
- Tests: 56 unit tests, 45 main-process tests, 10 embedding tests, 9 eye checks
  and 3 OCR checks; signed x64/arm64 build, packaged x64 Settings smoke and the
  clean-install/update verification pass.

## 3.4.0

Published 27 Nov 2026. The provider layer, optional semantic retrieval, speaker
labels and packaged-build checks in this release were verified locally and in
CI; the installer remains self-signed until a publicly trusted certificate is
installed.

- AI: provider architecture split out of `main.js` into `src/providers.js`.
  OpenAI-compatible, Anthropic-compatible, Ollama, LM Studio and custom endpoints
  are first-class; old profiles keep working because `auto` infers the family from
  the base URL. Chat, transcription and TTS each keep their own origin and key.
- AI: provider health checks (`providers:health`), model discovery per provider,
  local-first routing, backup failover, cancellation, per-request timeouts,
  first-token latency, token usage and approximate cost in the `done` event and a
  small usage line in the header.
- Audio: optional spoken-language pin (`transcribeLanguage`), a 60 s STT timeout,
  bounded transcript growth for long sessions, and bounded microphone/loopback
  recovery when a device disappears mid-session. The microphone now asks for echo
  cancellation, noise suppression and automatic gain control, with a plain-audio
  fallback when a driver rejects the constraint set. Speaker labels come from the
  two capture paths (`You` from the mic, `Them` from loopback); when the endpoint
  returns diarized segments, the optional provider-label mode uses those instead
  and falls back to the capture labels if it does not.
- Knowledge: optional semantic retrieval. Setting an embedding model sends each
  note to that endpoint once, caches the vector by content hash, and adds a
  bounded cosine boost to the local TF-IDF ranking; a failure, timeout or missing
  model falls back to lexical retrieval. The chat key is reused only on the same
  origin, so a local embedding server never receives a cloud key. Retrieval stays
  fully local when the model is blank.
- Knowledge: import a local text/markdown file into the knowledge base; retrieval
  is now hybrid TF-IDF cosine plus exact-phrase and heading bonuses, fully local;
  injected notes carry their source heading. Memory notes are visible, editable,
  individually deletable and permanently removable from Settings.
- Vision: frames are capped at 1920 px on the long edge and five per question,
  never written to disk, and the tray plus Settings warn that a frame can carry
  notifications or other people's data. OCR still runs locally through the
  in-box Windows engine.
- Providers: **Test chat** sends one real 8-token completion through the same
  request builder as an answer, so a gateway that lists models but rejects chat
  is caught in Settings instead of mid-interview.
- Usage: optional per-model cost overrides (`model = inputUSD, outputUSD` per 1M
  tokens) repricing models missing from the built-in list-price table.
- UX: first-run onboarding card, provider selects and presets, privacy dashboard,
  provider-health list, `aria-label`s on icon buttons, `role="status"` live
  regions for status and save messages, Escape-to-close settings, and a modal
  focus trap that restores focus to the gear when the dialog closes.
- UX: fixed a settings regression where saved-key placeholders referenced a
  missing function, so the dialog threw before opening. Saved keys now show a
  non-secret placeholder and keep the stored value on a blank submit.
- UX: removed the duplicate minimize control (the `▁` button next to hide) and
  its now-unused `window:minimize` IPC channel; hide (`–`) and close (`✕`)
  remain. Added reduced-motion-safe panel and settings-sheet entrances, smoother
  hover/press states, and a red close hover.
- Engineering: `src/logging.js` structured logs with secret redaction, wired into
  provider request/error/failover events; `scripts/ocr-probe.js` builds no native
  addon but exercises the OCR helper's success and error paths; CI builds the
  helper before `npm test` and keeps `npm audit` as a gate.
- Engineering: packaged-build smoke now drives the real Settings dialog (open,
  privacy dashboard, embedding and pricing controls, Escape, focus restore) and
  fails on any renderer error; `scripts/sign-identity.js` adds a PFX/thumbprint
  signing identity selected by environment, with the same timestamp and verify
  policy; every signed payload and installer is checked against the publisher
  pin, so a CA-issued PFX with a different subject cannot ship; the publisher
  comparison is RDN-order independent and rejects a CN suffix; `scripts/test-embeddings.js`
  adds 10 mocked-fetch tests.
- CI: every `electron-builder` invocation now passes `--publish never`. On a
  push to `master`, electron-builder's implicit CI publishing (`onTagOrDraft`)
  tried to upload a release after the installers were built, then failed because
  the job has no `GH_TOKEN`. `npm run check` rejects a build command without it.

## 3.3.7

Published 26 Nov 2026. The clean install of the signed installer and the
3.3.6 → 3.3.7 update were verified against the published release on fresh
Windows VMs (`release-verify` workflow), and the arm64 packaged build was
launched on a Windows on ARM runner.

**The concealment subsystem is removed.** The native addon (`cloak.node`), the C#
`hide-helper.exe`, the detector watch, PEB and command-line rewriting, ETW
suppression, module unlinking, DACL sealing, DWM cloaking, host reparenting, the
window-class literal patch and the scramble mode are all gone. They existed to
defeat inspection, not to keep the panel out of a screen share, and they made the
app misrepresent what it was. What remains is `win.setContentProtection(true)`:
Windows' documented capture-exclusion flag. OCR is now a small purpose-built
helper (`scripts/ocr-helper.cs`) that accepts an image path and returns recognised
lines — it has no window commands. `npm run check` fails if any removed component
reappears.

**The installer no longer grants machine-wide trust.** It used to run
`certutil -addstore Root` on a self-signed certificate, which made every user on
the machine trust a private key held on a build machine. That import is removed,
along with the System32/SysWOW64 cleanup, the PowerShell `-ExecutionPolicy Bypass`
script, and the kill-by-image-name block. The installer removes the legacy
certificate and the old identities; it adds nothing to a trust store. Existing
machines can run `scripts/remove-trust.ps1` (elevated, supports `-DryRun`).
Authenticode now reports **Unknown publisher**, which is the honest state for a
self-signed build.

**The update chain verifies what it installs.** `publisherName` is pinned to the
certificate subject, `autoDownload` and `autoInstallOnAppQuit` are off, downgrades
are refused, and the download/install steps are explicit user actions. Release
signing fails closed when `REQUIRE_SIGNING=1` and `signtool` is missing, and every
signed PE is re-verified with `signtool verify /pa /all` after the post-sign
resource edit.

**The IPC boundary is the app's own page, not any `file://` page.** Handlers now
require the exact app URL, the main frame, and the app's own `webContents`.
Navigation away, window.open, webview attachment and non-app redirects are denied
globally. Permissions are granted only to the app origin, `clipboard-read` is
gone, and display capture checks the requesting frame. Provider URLs must be HTTPS
or loopback HTTP; keys are bound to the origin they were entered for; `config:set`
and `state:set` validate shape and size.

**All 25 invoke channels have a payload schema.** The sender check proves who is
calling; the schema proves what arrived. Unknown channels, unknown config keys,
wrong types, non-finite numbers, over-long strings, oversized state and malformed
audio/ask/memory/image payloads are rejected before a handler runs, with a stable
`invalid payload for <channel>` error. The tables live next to `handle()` in
`src/main.js`, and `scripts/test-main.js` exercises the malformed cases.

**Audio capture requires explicit consent, and the indicator cannot be missed.**
The first Listen (including a hotkey or resumed captions) shows a blocking notice
that names the sources, the transcription provider, and the need for everyone's
consent. Nothing is opened until the user agrees; the agreement is timestamped and
can be withdrawn in Settings. A red **Listening** pill is shown for as long as a
microphone or loopback stream is open.

**The transcript is opt-in and off by default.** It stays in memory and is erased
on quit unless *Save the live transcript across restarts* is enabled. Main enforces
the same rule: `state:set` drops transcript fields unless `persistTranscript` is
true, and turning it off rewrites the stored state without them. A pre-3.3.7
profile that still contains a transcript is scrubbed on first launch. This closes
the default-persistence gap (MEM-03).

**Electron 45.** The runtime moves from 33 (end-of-life) to 45, with the fuses
configuration retained. `npm run check` fails when the Electron major leaves the
supported 43–45 window, so the next bump cannot be forgotten silently.

**The packaged build is verified, not assumed.** `npm run verify:build` reads the
fuse wire and PE machine type back from the shipped executable, checks that only
`app.asar` is loadable, confirms the OCR helper shipped, checks the
`app-update.yml` publisher pin against `win.signtoolOptions.publisherName`, and
optionally starts the packaged app and waits for its smoke marker. CI builds the
x64 payload and runs it; a Windows on ARM workflow does the same for arm64,
including the launch.

**CI and branch protection.** `.github/workflows/ci.yml` runs the check script,
the test suite, a security grep for the removed patterns, `npm audit`, and the
packaged-build verification. The default branch takes changes through a pull
request, requires the `verify` and `package-x64` checks, blocks force pushes and
deletions, and requires conversation resolution. CI-only builds set `SKIP_SIGNING=1`; a release build with
`REQUIRE_SIGNING=1` ignores that skip and fails closed.

## 3.3.6

**Named Glance AI end to end; RuntimeBroker impersonation removed.** The app
used to install as `RuntimeBroker.exe` in a hidden `SysWOW64` mirror, with
Microsoft's name in its version resource and a non-Microsoft signer — a
permanent mismatch a scanner could flag. It now builds as `GlanceAI.exe` in
`%ProgramFiles%\Glance AI\`, with `CompanyName`/`FileDescription` = `Glance AI`,
window title `Glance AI`, Run value `Glance AI`, profile `%APPDATA%\Glance AI`,
and a reissued certificate (`CN=Glance AI, O=Glance AI, C=US`) that matches the
resource. The installer no longer mirrors anything into `System32`; it deletes
the old RuntimeBroker mirror, Run value, scheduled task and profile on upgrade,
and migrates the newest profile data into the new folder. PEB sanitization now
publishes the real executable path with the argv stripped instead of a spoofed
Windows path. Trade, stated plainly: a name scan now finds the app immediately,
and the certificate is self-signed rather than publicly trusted. Capture
exclusion, the detector watch and the process hardening are unchanged.

**Child command lines no longer read as Electron.** The browser process used to
show the stripped argv while its three Chromium helpers still showed
`--type=renderer --user-data-dir=…`, which any same-user scanner can read out of
their PEB. The main process now rewrites each helper's command line, image path,
window title and working directory from outside once per PID
(`sanitizeRemotePeb()`), on a 500 ms watcher, and refuses a WOW64 child rather
than guessing the layout. Measured: sandboxed renderer, GPU and network utility
all read back `"…\GlanceAI.exe"`; a plain Node child reads back the same through
WMI. Probes:
`node scripts/remote-peb-probe.js`, `scripts/child-peb-probe.js`.

**The helper is compiled and signed at pack time.** The first launch used to
write `hide-helper.cs` to `%TEMP%`, spawn `csc.exe` and leave an unsigned exe
beside it. Packaged builds now ship `resources/hide-helper.exe`, built by
`scripts/build-hide-helper.js` in `beforePack` and signed with the same
certificate as the app; the app runs that copy from the install tree. Dev
checkouts keep the TEMP fallback. The build also adds the missing
`System.Runtime` facade reference that made every WinMD compile fail with
CS0012 (the OCR helper had been silently unbuildable on machines without the
reference assemblies).

**More native proctoring clients are watched.** Examplify/ExamSoft, Examus,
Pearson OnVUE, Kryterion, College Board Bluebook, ProctorExam, ProctorFree,
Meazure and Caveon are added to the affinity-flag watchdog, so the flag is
dropped and the text scrambled while any of them is running.

## 3.3.5

**Chunks end at a pause, not at a stopwatch.** A fixed 1.5 s cut lands inside a
word about as often as between two, and the half-word is gone — the model never
sees it. The recorder now watches the level of the chunk it is recording and stops
at the first quiet moment after roughly a second, so boundaries fall between
words. Measured on spoken sentences with pauses: three lines, each a complete
sentence, instead of clipped fragments.

**The chunk length follows the model.** `small.en` needs about twice the audio per
call to stay real time on a CPU; at 1.5 s chunks it fell behind and read worse
than base. The renderer now uses 3 s chunks when the configured transcribe model
is small/medium/large, 1.5 s otherwise.

**Continuation lines merge.** A chunk that does not end a sentence continues the
previous line for the same speaker instead of starting a new fragment.

Measured and dropped: passing the previous text as `initial_prompt`. On short
chunks the model echoed the prompt's own tail instead of the audio — the second
chunk came back as "10-" — so it is not in the build.

Measured after the change, one spoken clip with pauses:

```
Them: Live Cap options work well now.
Them: The next sentence starts after a pause.
Them: And this one end.
Them: the test. We'll see you next time. Bye.
```

Three complete sentences and one continuation; the sign-off on the last line is
Whisper's habit on trailing silence, not audio that was there.

## 3.3.4

**It stops transcribing itself.** Read-aloud plays through the same output device
the loopback records, so the panel's own voice was being captioned back into the
transcript. The player now marks itself as speaking for the length of the clip and
the listen loops stand down until it ends.

**It stops inventing lines.** Whisper answers music, noise and silence with a
sentence of its own — "Thank you.", "Thanks for watching." — which is what landed
in the transcript whenever a video had music under the speech. The worker now
drops a segment when the model reports no speech (`no_speech_prob > 0.55`) or
when its own confidence is low (`avg_logprob < -1.1`).

Measured: three seconds of digital silence returns an empty transcript instead of
a made-up sentence, and the same worker still returns the spoken sentence
verbatim.

The caption mode from 3.3.3 is unchanged: 1.5 s chunks, listening starts on
launch, no API key when it runs against the local server.

## 3.3.3

**Live captions.** A new toolbar mode turns Glance into a subtitle layer: it
starts listening on launch and cuts the audio into 1.5 s pieces, so a line lands
while the sentence is still being spoken. The state lives in the config, so
launching the app is the only action — no Listen button, no browser, no window to
keep in front.

- 1.5 s chunks (Fast is 4 s, normal 7 s), question detection at 0.7 s.
- Resumes by itself on the next launch.
- Against the local server's on-device Whisper it needs no API key at all; against
  a remote STT endpoint it is the same code path.

The local worker also gained a repetition guard. A 1.5 s chunk is exactly the
case where Whisper repeats one sentence until the token budget runs out — one
chunk came back as the same line thirty times. Repeats and doubled words are now
collapsed before the text reaches the transcript.

Measured on this machine, model warm: first caption line 432 ms after speech
started, a 1.5 s chunk transcribed in ~0.9 s.

## 3.3.2

**One model, both sides of the call.** Audio and chat no longer need two model
names. `transcribeModel` is optional: blank means "use the chat model" on the
same base URL with the same key, so a gateway that transcribes with the model it
chats with needs no second configuration. The field survives for providers whose
audio model really is different (a dedicated whisper endpoint).

- **Both sources by default.** The source selector starts on *Both (you + them)*
  instead of mic only, so the interviewer's side and yours land in the transcript
  with `You:` / `Them:` labels without a trip to the dropdown. Loopback is
  granted in the main process (`setDisplayMediaRequestHandler`), so no picker
  appears; if the system track cannot be opened the mic still runs and the status
  line says which half failed.
- **Fast is on at boot.** Fast mode existed behind a button and started off,
  which meant a fresh install used 7 s chunks until someone found it. It now
  starts on — 4 s chunks, 1.2 s question detection — and the toggle still applies.
- The settings field now says what blank means, instead of looking like a
  required value that had been pre-filled with `whisper-1`.

## 3.3.1

**The compositor stops assuming things.** 3.3.0 took the panel out of the
capture path by compositing it back from the renderer. This release closes the
ways that could quietly paint the wrong thing:

- `capturePage()` is retried once when it returns an empty surface — a
  compositor that has not produced a frame yet, or a GPU process restart. An
  empty paste used to be a transparent hole in the screenshot.
- The alpha encoding is sniffed instead of assumed. A straight-alpha surface
  blended with the premultiplied formula leaves a dark fringe on the panel's
  rounded corners; the blend now picks the formula the buffer actually needs.
- Fully opaque rows are copied in one call, so the per-pixel blend is only paid
  near the rounded edge.
- A window capture aimed at the panel itself is composited too. It used to come
  back empty, because the flag applies to windows exactly as it does to a
  display.

`npm run probe:composite` is the regression test for the pair of properties
that have to hold together: it samples `GetWindowDisplayAffinity` 300 times at
8 ms while triggering two captures, and requires `0x11` in every sample **and**
a non-zero composite rectangle per capture. Dropping the flag also produces
"the panel is in the frame", and never compositing also produces "the flag never
moved" — the probe only passes when both are true at once.

Measured on this machine: `0x11` in all 300 samples, two 764x604 composites at
408,0 (461,456 px each).

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
map in HARDENING.md (removed in 3.3.7).

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
- Product and binary are **Glance AI** (`ProductName`, `FileDescription`, `OriginalFilename`, window title, install folder `C:\Program Files\GlanceAI`).
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
