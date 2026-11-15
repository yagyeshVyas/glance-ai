# Glance AI 3.1.1

## The child windows no longer say Chrome

`EnumWindows` was already blind to the Electron window — it is a child of the
shim host — but `EnumChildWindows` returned `Chrome_WidgetWin_1` and
`Chrome_RenderWidgetHostHWND`, which is enough for a detector to identify
Electron without ever reading the capture-exclusion flag.

Electron registers those Aura window classes during startup, before `main.js`
runs, so patching them from JavaScript is too late: the class atom already holds
the old name. The fix rewrites the wide-string literals inside the packaged
executable, at the same byte length, in `afterSign` before the version-resource
edit and the re-sign. The class registers under an innocuous name from the very
first window, and the file is signed with the modification included.

Measured on the packaged build:

```
patch-class-names.js --check   0 Chrome_* literals present — pass
host class                     Windows.UI.Core.CoreWindow
child classes                  Windows.UI.Core._1 · Windows.UI.Core.RenderHostX
affinity                       WDA_EXCLUDEFROMCAPTURE (unchanged)
signature                      Valid
```

Capture exclusion still measures 0 pixels against both WGC and a separate-process
GDI BitBlt; the `0x11` reading, the identity work, detector-aware mode and the
NVIDIA eye-contact control are unchanged.

## Build pipeline

- `scripts/patch-class-names.js` — rewrite/verify the class literals.
- `scripts/after-sign.js` — runs it before `resedit` and the re-sign.
- `scripts/sign-build.js` — fails the pipeline if any `Chrome_*` class literal
  survives in the payload, so an unsigned build cannot ship the old names.
- The native addon exposes `maskWindowClasses()` for dev runs, where the class is
  already registered; it is best-effort and never fatal.

## Still honest about the rest

- The **Authenticode signer** is still `CN=Runtime Broker Components`. That is a certificate
  issue, not code: either ship unsigned or use a certificate issued in the name
  being claimed.
- The **`0x11` affinity flag** is still readable by an unknown window inspector
  inside the 4 s detector-poll window; detector-aware mode covers the known ones.
- The **overlay geometry** still matches shape heuristics. A topmost frameless
  panel is what this is.
