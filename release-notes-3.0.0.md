Answers you can trust, and a report card for the hiding.

## Answers

- **Offline knowledge base.** Paste a cheat sheet, star stories or project notes. Entries are split on blank lines and scored on-device against the question; only the best few ride along with it. No embeddings, no network, no per-turn cost — and the model answers from your facts instead of guessing at them.
- **Dual-stream listening.** The audio source has a new *Both* option: a mic loop and a system-loopback loop run at once, and each transcript line is labelled **You** / **Them**. The text sent to the model stays plain speech, so labels never confuse the answer.
- **Meeting detection.** Zoom, Teams, Webex, Discord, Skype, or a browser tab titled like a meeting produces one notice per run with the listen hotkey — detection only, it never opens the mic on its own.
- **Answer styles** (smart / brief / STAR / bullets / code-first / detailed) and a **backup provider** carry over from 2.0.0.

## Hiding — now measured per tell

- The single ghost check became a **stealth report**: the same capture A/B, then a readback of the window class, ex-style, title, Chromium child count, accessibility state and DevTools port file. Ten rows, each green/amber/red, each a measurement rather than a restatement. On the machine this build was cut on: **8 pass, 2 amber, 0 red** — the two amber rows are the honest ones, that the title says "assistant" and that one Chromium child window remains if a detector walks children.
- **Panic hide** on `Ctrl+Alt+X`: the panel is gone from any state, instantly.
- Ghost mode, the host-class shim, the affinity flag, capture exclusion and scramble mode are unchanged and still on by default.

## UI

Status is a pill instead of loose text, primary actions are marked, the toolbar is quieter, answers get a readable type and real code blocks, and Settings gained sections, focus rings and the report panel.

## Release pipeline fix

Signing runs after electron-builder writes `latest.yml`, so every published checksum described the pre-signature file and `electron-updater` rejected downloads — silently, because a failed checksum never reaches the user. `latest.yml` is now re-stamped from the signed artifacts and stale blockmaps are dropped. The 2.0.0 assets were corrected in place; this release ships with correct hashes from the start.

## Verification

`npm run check` clean · **20 helper + 25 main-process tests** (knowledge ranking and injection are new) · stealth report **PASS, 0 red** · capture A/B **PASS** · scramble probe **PASS** · dual-stream start/stop **PASS** · layout probe: no clipping, no horizontal overflow at 760×600 or 420×360. Installers signed, `signtool verify /pa` passes.

## Install

| Arch | File |
|---|---|
| x64 | `assistant-3.0.0-x64.exe` |
| arm64 | `assistant-3.0.0-arm64.exe` |

Installed 1.0.2+ builds update themselves from this release.

## Honest limits

- A proctoring tool that calls `GetWindowDisplayAffinity` still reads `0x11`; use scramble + stealth off for that case.
- Chromium child windows still carry a `Chrome_WidgetWin` class — visible only to something that walks children.
- Windows only. macOS is not supported (Ghostbar is native Swift and will feel better there), there is no bundled local STT model, and no file-importing RAG index — NexQ has both.
- Screen share is solved; proctored exams are not. See `STEALTH.md`.
