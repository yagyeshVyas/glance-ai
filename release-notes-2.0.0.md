Ghost mode, a check that proves it, and a working native build.

## Hiding

- **Ghost mode** is now the default and is enforced in the main process, not just by the Settings checkboxes. A profile saved with weaker toggles is raised to the full stack on load.
- **Ghost check** — Settings → *Run ghost check*. It captures the panel, hides it, captures the same region again and compares the pixels, then reads `GetWindowDisplayAffinity` back. A pass names the mechanism (`0x11` excluded) instead of only saying "something changed". On the build published here: `ok: true`, `affinity: 17`, `mechanism: excluded`, and the same region byte-identical with the panel shown and gone.
- **Scramble mode** — documented since 1.0.1 but never implemented — now exists. With stealth off the window stays capturable at affinity `0` and the glyphs shuffle ~8×/s instead. Copy and read-aloud read the untouched text, so the real answer survives.
- The title blend lands on the host window immediately instead of leaving an untitled top-level window for up to five seconds.
- An occluded overlay keeps painting: Chromium's background/occlusion throttling is off.

## Correction, measured

`cloak.cpp` claimed `DWMWA_EXCLUDED_FROM_CAPTURE` (16) excludes a window from capture while leaving the affinity flag at 0. On Windows 11 26300 it does not: `DwmSetWindowAttribute` returns `S_OK` and both a GDI `BitBlt` and a WGC capture still see the window. No DWMWA id from 16 to 40 does better. `SetWindowDisplayAffinity` stays the mechanism and the constant is documented as a no-op instead of sold as a second layer. Reproduce with `node scripts/dwm-exclude-probe.js`.

## Power

- **Backup chat provider**, used only after the primary exhausts its retries or hard-fails. It keeps its own origin, key and model, so a key never travels to a host it does not belong to.
- **Answer styles** — smart, brief, STAR, bullets, code-first, detailed — replacing the binary smart toggle, which is still honoured for old profiles.

## Build

A fresh checkout could not build the native addon at all: Node 26's headers stamp clang-only flags onto the generated project and VS2019's `link.exe` dies on `/opt:lldltojobs=2` with LNK1117. `scripts/build-native.js` now owns configure → strip → build → PE machine-type verification, and packaging runs it per arch.

## Verification for this release

`npm run check` clean · 23 main-process tests, 6 of them new (failover ×3, styles ×2, ghost wiring) · `npm run audit` flags exactly one window as `capture-excluded` · capture A/B **PASS** · ghost check **PASS** · scramble and settings probes **PASS** — all re-run against the installed build, not only the dev tree. Installers are signed and `signtool verify /pa` passes.

## Install

| Arch | File |
|---|---|
| x64 | `assistant-2.0.0-x64.exe` |
| arm64 | `assistant-2.0.0-arm64.exe` |

Installed 1.0.2 builds update themselves from this release via `latest.yml`.

## Known limits

- A proctoring tool that calls `GetWindowDisplayAffinity` still reads `0x11`; switch to scramble + stealth off for that case.
- Screen share is solved, proctored exams are not. See `STEALTH.md`.
- Windows 10 2004+ or Windows 11 only. Before 2004 the flag degrades to `WDA_MONITOR` (a black block) rather than a hidden window.
