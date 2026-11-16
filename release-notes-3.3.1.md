# Glance AI 3.3.1

## The compositor stops assuming

3.3.0 took the panel out of the capture path by compositing it back from the
renderer instead of dropping the capture flag for the screenshot. That works,
and it introduced a new piece of code whose failure modes are quiet: it paints
pixels nobody asked it to paint. This release closes the ways it could do that.

**An empty compositor read.** `capturePage()` can return a zero-sized surface —
a window that has no frame yet, a compositor that just restarted with the GPU
process. Pasting that painted a transparent hole into the screenshot, and the
model would then be asked about a frame with a missing rectangle. The read is
retried, and if it stays empty the screen frame is used unchanged rather than
damaged.

**The alpha encoding.** Windows Skia hands back premultiplied BGRA, and the
blend assumed it. Premultiplied and straight alpha need different formulas; using
the wrong one leaves a dark fringe on the panel's rounded corners. The buffer is
now sniffed — in a premultiplied surface no colour channel can exceed its alpha —
and the blend picks the formula the buffer actually needs.

**The cost of the blend.** Fully opaque rows are copied with one `Buffer.copy`
instead of 760 four-byte stores. A glass panel is transparent only near its
rounded edge, so nearly every row takes the fast path and the per-pixel blend is
paid for a few rows per capture.

**A window capture of the panel itself.** It came back as an empty frame for the
same reason a display does: the flag applies to windows, not only to screens.
The page fills that window exactly, so the whole frame is now the composite.

## The probe that has to pass

`npm run probe:composite` exists because either property alone is easy and
misleading:

- dropping the capture flag makes "the panel is in the frame" true, and
- never compositing makes "the flag never moved" true.

The probe requires both at once. It samples `GetWindowDisplayAffinity` on the
host window 300 times at 8 ms while triggering two captures through the app's
own path, then reads the trace log for the composite rectangles:

```
host windows : 1
affinity     : 0x11 over 300 samples (8 ms apart)
composites   : 2 — 764x604 at 408,0 (461456 px); 764x604 at 408,0 (461456 px)

PASS — the flag stayed 0x11 and every capture still contains the panel
```

Run it against a dev instance started with its own profile, so it does not fight
an installed copy for the single-instance lock:

```
RB_PROFILE_DIR=%TEMP%\rb-dev-profile <electron> . --remote-debugging-port=9333
npm run probe:composite
```

## Unchanged

The `0x11` read itself, the Authenticode/resource mismatch, child `--type=renderer`
command lines and the SysWOW64 mirror path. See [HARDENING.md](HARDENING.md) §3–4.
