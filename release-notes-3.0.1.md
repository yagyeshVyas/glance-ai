Capture protection came back off after every hide/show cycle.

## The bug

`hide-helper uncloak` calls `SetWindowDisplayAffinity(h, WDA_NONE)` on the window root and nothing re-asserted it. Startup was fine — startup cloaks, it does not uncloak — so the panel was protected until the first `Ctrl+Shift+H`. On show it sat on screen fully capturable. `Ctrl+Alt+X` then `Ctrl+Shift+H` was enough to expose it, and the in-app check still said green because it ran its own `hide()` last and only ever measured the hidden direction.

`applyDeepStealth` now re-asserts stealth after the style and cloak writes, in both directions, and the host's window style is re-keyed before the flag is set so a lost colour key cannot leave `0x11` set but ineffective.

## How the tests missed it, and the new guard

`capture-ab.js` and the report both hide the panel before hashing, so only the hidden direction was ever measured. New `scripts/external-capture-test.js` captures from a **separate PowerShell/GDI process** — the path Snipping Tool and Zoom's `zVideoUI` use — with the panel on screen, and requires the capture to match the panel-hidden reference. A control turns protection off to prove the sampled region really is the panel.

## The check itself was rebuilt

Three oracles failed before one held up, and each failure is recorded rather than papered over:

- **Byte hashes**: an excluded capture shows the live desktop behind the panel, which changes between samples. Two healthy runs reported FAIL.
- **Mean luminance**: better, but content-dependent — over a dark terminal panel and desktop both read ~30.
- **Current**: three references back to back (panel off-screen, unprotected, protected), medians each, OS-sourced window rectangle, and an explicit **inconclusive** verdict when the references do not separate instead of a verdict it cannot support.

The OS rectangle matters on its own: `win.getBounds()` disagrees with where the composed window actually is after a reparent — measured 179px off — so the sample was landing outside the panel.

## Verified on the installed build

| Check | Result |
|---|---|
| `npm run check` | clean |
| `npm test` (20 helper + 25 main) | pass |
| stealth report | PASS, 0 red |
| capture A/B | PASS |
| `npm run audit` | `capture-excluded`, one window |
| attack surface | host class `WinUIDesktopWin32WindowClass`, affinity `0x11`, no taskbar or Alt-Tab entry |

## Known caveat

The report's capture row can come back **inconclusive (amber)** instead of green. That is deliberate: over a uniformly dark desktop the panel and the background are genuinely hard to tell apart by luminance, and the row says so rather than guessing. The command-line test (`node scripts/external-capture-test.js`) is the more reliable oracle because it uses a larger region and its own control.

Installed 3.0.0 and older builds update themselves from this release.
