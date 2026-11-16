# Glance AI 3.3.0

## The screenshot no longer exposes the panel

Every screen capture the app took — the `Ctrl+Alt+Enter` ask, the five-frame
pile, the copilot's periodic look — dropped
`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` for the length of the grab,
then put it back. The flag had to go: a protected window is excluded from the
capture, so the panel the user is asking about would be missing from the frame.

That workaround had a cost nobody had measured. For 100–400 ms per capture the
panel was an ordinary window: any screen share running at the same time — a
browser tab in Meet or Teams, OBS, a recorder — sampled it at 30 fps. Nothing
was wrong with the capture exclusion; it was simply off while the app took its
own picture.

3.3.0 keeps the flag on and puts the panel back a different way. The display is
captured with the panel excluded, the panel's own surface is rendered by the
renderer (`capturePage()` — a compositor read, not a screen capture, so the
flag does not apply), and the two are composited. The frame the model sees still
shows the panel; no other capturer ever can.

Measured on this machine, two captures in a 2 s window:

```
host GetWindowDisplayAffinity   0x11 in all 260 samples (8 ms apart)
composite                       461,456 px at 408,0 764x604 (unit 1.25)
```

The rect comes from a new `windowRect()` export on the native addon, read from
the host window: after the blend, `win.getBounds()` is Electron's stale idea of
where the child is (measured 179 px off) and would have pasted the panel in the
wrong place.

## One publisher, and it is not a person

The certificate every installer ships carried the author's own name in its
subject — the last place a personal identity appeared in a build, and the one
a `Get-AuthenticodeSignature` call reports. This release replaces it:

| Surface | 3.2.0 | 3.3.0 |
|---|---|---|
| Authenticode subject | `CN=<author>` | `CN=Runtime Broker Components, O=Runtime Components, C=US` |
| Installer trust store | old root imported | new root imported, old root **deleted** |
| package.json publish owner | author's handle | `runtimebroker` |
| website footer / LICENSE | author | project name |
| README, USAGE, docs | author's repo URLs | project repo URLs |

The retired certificate's thumbprint is removed from `LocalMachine\Root` and
`LocalMachine\TrustedPeople` by `customInstall`, so a machine that ran an older
build does not keep it.

The private key never enters the repository: `scripts/make-cert.ps1` writes the
`.pfx` to `%USERPROFILE%\.runtimebroker-signing\`, and only the public
`build/codesign.cer` is committed. `src/signing.js` is the single source for the
thumbprint — the build hooks, the post-build installer pass and the audit probe
all read it, instead of three copies and a command line.

## One name is not enough: it has to leave the history

A public repository shows the old commits in a browser even after every file is
rewritten, and `git log` is what a search engine indexes. `scripts/scrub-identity.js`
does the replacement in the working tree (`--check` fails a build that still
names the author), and the same script runs inside a `git filter-branch
--tree-filter` pass so every commit reachable from every ref is rewritten. The
old objects are then expired and garbage-collected, because a rewritten commit
is still present in `.git` until then.

## Also in this release

- `windowRect(hwnd)` on the native addon: the composed position of a window, for
  the compositor above and for any future probe that needs the real rect.
- `RB_PROFILE_DIR` — the probes can start an isolated instance (own profile, own
  single-instance lock) beside a running one. Previously a probe launched while
  the app was running simply exited on the instance lock.
- `scripts/cdp-eval.js` and `scripts/capture-frame.js` — evaluate in the running
  renderer and save the exact frame the app's screenshot path produces.
- The vendored camera filter no longer contains a build-machine path in its
  debug directory.

## Still open, unchanged

The `0x11` affinity read, the Authenticode/resource mismatch, child
`--type=renderer` command lines, the unsigned `%TEMP%` helper and the SysWOW64
mirror path. Ranked in [HARDENING.md](HARDENING.md) §4.
