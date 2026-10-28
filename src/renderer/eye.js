// ---------- NVIDIA-style eye tracking (inbuilt, free, local) ----------
// Uses MediaPipe Face Landmarker (runs on-device, no API key, no server).
// Produces gaze direction (left/right, up/down), blink detection, and an
// "attention" score that can be injected into prompts so the assistant knows
// whether the user is looking at the screen or distracted.
//
// All MediaPipe assets (WASM + model) are vendored and served locally over the
// mplocal:// scheme by the main process — fully offline, zero network egress.

const EYE = {
  on: false,
  busy: false,
  defaultOn: true, // eye tracking + camera auto-start on launch (stealth-safe)
  debug: true, // draw the live webcam frame + face mesh to the HUD canvas
  video: null,
  landmarker: null,
  canvas: null,
  ctx: null,
  stream: null,
  raf: 0,
  wantOn: false, // user wants the camera on — retry while true
  retryTimer: 0,
  cameraId: 'auto', // 'auto' or a videoinput deviceId — which camera the morph uses
  // latest readings (updated every frame while on)
  state: {
    visible: false,
    gazeX: 0, // -1 (left) .. +1 (right)
    gazeY: 0, // -1 (up) .. +1 (down)
    blink: false,
    attention: 0, // 0..1 — how focused/looking-at-screen
    faceCount: 0,
  },
  // smoothed history for the attention score
  _attnHist: [],
  // callbacks
  onStatus: null,
  onFrame: null,
};

// Fully local: the MediaPipe bundle + model are vendored at
// renderer/vendor/mediapipe/ and served over a custom scheme (mplocal://app/)
// by the main process. Chromium refuses cross-origin fetch/XHR on file:// into
// an asar archive, so the main process registers a tiny asar-backed protocol
// handler for exactly these assets. No CDN, no egress — fail closed.
const MP_BASE = 'mplocal://app/';

// landmark indices (MediaPipe FaceMesh / Face Landmarker)
const L = {
  noseTip: 1,
  leftEyeInner: 133,
  leftEyeOuter: 159,
  rightEyeInner: 362,
  rightEyeOuter: 334,
  leftLidTop: 159,
  leftLidBottom: 145,
  rightLidTop: 362,
  rightLidBottom: 374,
  forehead: 10,
  chin: 152,
};

function mpStatus(msg, err) {
  if (EYE.onStatus) EYE.onStatus(msg, err);
}

// vision_bundle.mjs is an ES module exposing named exports (FaceLandmarker,
// FilesetResolver, GpuDelegate). Load it once and keep the module handle.
let _mpModule = null;
async function ensureVisionModule() {
  if (_mpModule) return _mpModule;
  const localUrl = MP_BASE + 'vision_bundle.mjs';
  _mpModule = await import(localUrl);
  if (!_mpModule.FaceLandmarker) throw new Error('MediaPipe bundle missing FaceLandmarker export');
  return _mpModule;
}

// Read a vendored asset (served over the mplocal:// scheme) to bytes. Both the
// WASM binary and the .task model are loaded this way so the MediaPipe bundle
// never resolves file paths itself (its null fileset would otherwise crash).
// The custom scheme is an opaque origin the main process serves, so a plain
// fetch() is all that's needed.
async function fetchBytes(label, url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.byteLength) throw new Error('empty response');
    return buf;
  } catch (e) {
    throw new Error(label + ': ' + (e && e.message ? e.message : e) + ' for ' + url);
  }
}

async function ensureLandmarker() {
  if (EYE.landmarker) return EYE.landmarker;
  const vision = await ensureVisionModule();
  const modelBytes = await fetchBytes('model', MP_BASE + 'face_landmarker.task');
  // Load the WASM loader via <script> (defines self.ModuleFactory). The
  // loader is Emscripten MODULARIZE output: ModuleFactory(moduleArg) returns
  // a compiled WASM instance. We patch it to inject the wasmBinary bytes so
  // the Emscripten runtime never tries to fetch the .wasm by URL.
  const loaderUrl = MP_BASE + 'vision_wasm_internal.js';
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = loaderUrl;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + loaderUrl));
    document.body.appendChild(s);
  });
  if (typeof self.ModuleFactory !== 'function') throw new Error('WASM loader did not set ModuleFactory');
  const wasmBinary = await fetchBytes('WASM', MP_BASE + 'vision_wasm.wasm');
  const realFactory = self.ModuleFactory;
  // Use instantiateWasm to inject the binary directly, bypassing the
  // factory's Module-merging. locateFile is neutralized so it doesn't call
  // undefined.toString() on the unset asset path. The bundle calls
  // self.ModuleFactory again — we return the same prepared instance.
  const instance = await realFactory({
    locateFile: (f) => f,
    instantiateWasm: async (imports, success) => {
      const mod = await WebAssembly.instantiate(wasmBinary, imports);
      success(mod.instance, mod.module);
    }
  });
  self.ModuleFactory = () => instance;
  // Now use FilesetResolver so the bundle's Bh() gets a valid (non-undefined)
  // wasmLoaderPath to load via <script>, and locateFile() returns a valid
  // wasmBinaryPath string for the .wasm redirect.
  self.__MEDIPIPE_ASSET_PATH__ = MP_BASE;
  const fileset = await vision.FilesetResolver.forVisionTasks(MP_BASE);
  // numFaces: 4 — a call/screen often shows several faces; we pick the largest
  const opts = { runningMode: 'VIDEO', numFaces: 4, baseOptions: { modelAssetBuffer: modelBytes } };
  EYE.landmarker = await vision.FaceLandmarker.createFromOptions(vision, opts);
  return EYE.landmarker;
}

function norm(p) {
  return p ? { x: p.x / EYE.video.videoWidth, y: p.y / EYE.video.videoHeight } : null;
}

function estimateGaze(lm) {
  const leI = norm(lm[L.leftEyeInner]);
  const leO = norm(lm[L.leftEyeOuter]);
  const reI = norm(lm[L.rightEyeInner]);
  const reO = norm(lm[L.rightEyeOuter]);
  const nose = norm(lm[L.noseTip]);
  if (!leI || !leO || !reI || !reO || !nose) return null;
  // gaze direction: where the eyes point relative to nose
  const gx = ((leI.x + reI.x) / 2 - nose.x) * 4; // scale to ~-1..1
  const eyeTopY = (leI.y + reI.y) / 2;
  const gy = (eyeTopY - nose.y) * 6;
  return { x: Math.max(-1, Math.min(1, gx)), y: Math.max(-1, Math.min(1, gy)) };
}

function estimateBlink(lm) {
  const leT = norm(lm[L.leftLidTop]);
  const leB = norm(lm[L.leftLidBottom]);
  const reT = norm(lm[L.rightLidTop]);
  const reB = norm(lm[L.rightLidBottom]);
  if (!leT || !leB || !reT || !reB) return false;
  const leH = Math.abs(leB.y - leT.y);
  const reH = Math.abs(reB.y - reT.y);
  const avgH = (leH + reH) / 2;
  // relative to face height
  const chin = norm(lm[L.chin]);
  const fore = norm(lm[L.forehead]);
  const faceH = Math.abs(chin.y - fore.y) || 1;
  return avgH / faceH < 0.25;
}

// normalized bounding box of a face's landmarks
function faceBBox(lm) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, area: (maxX - minX) * (maxY - minY) };
}

// Pick the most prominent (largest) face on screen — for a self-view or a
// single-person camera page that is the user's own face.
function pickLargestFace(faces) {
  let best = null, area = -1;
  for (const f of faces) {
    const a = faceBBox(f).area;
    if (a > area) { area = a; best = f; }
  }
  return best;
}

function frameTick(now) {
  if (!EYE.on) return;
  EYE.raf = requestAnimationFrame(frameTick);
  if (!EYE.video || EYE.video.readyState < 2 || !EYE.landmarker) return;
  // ~10 fps is plenty for gaze/attention and keeps CPU + GPU low
  if (now - (EYE._lastDetect || 0) < 90) return;
  EYE._lastDetect = now;
  const t = performance.now();
  let res;
  try {
    res = EYE.landmarker.detectForVideo(EYE.video, t);
  } catch {
    return;
  }
  const lm = res && res.faceLandmarks ? pickLargestFace(res.faceLandmarks) : null;
  const s = EYE.state;
  if (!lm) {
    s.visible = false;
    s.faceCount = 0;
    s.attention = Math.max(0, s.attention - 0.05);
    EYE._attnHist.push(0);
  } else {
    s.visible = true;
    s.faceCount = res.faceLandmarks.length;
    const g = estimateGaze(lm);
    if (g) {
      s.gazeX = g.x;
      s.gazeY = g.y;
    }
    s.blink = estimateBlink(lm);
    // attention: face visible, eyes roughly centered, not blinking
    let score = 0.5;
    if (g) {
      const offAxis = Math.min(1, Math.sqrt(g.x * g.x + g.y * g.y) / 0.8);
      score += (1 - offAxis) * 0.3;
    }
    if (s.blink) score -= 0.3;
    s.attention = Math.max(0, Math.min(1, score));
    EYE._attnHist.push(s.attention);
  }
  if (EYE._attnHist.length > 30) EYE._attnHist.shift();
  if (EYE.onFrame) EYE.onFrame(s);
  // Draw the live camera + face-mesh overlay to the canvas so the HUD can
  // mirror it. The canvas is the only surface that shows the webcam feed;
  // it is small (48x36 in the HUD) and drawn by the user's explicit opt-in.
  if (EYE.ctx && EYE.canvas) drawDebug(lm);
}

function drawDebug(lm) {
  const c = EYE.canvas;
  const ctx = EYE.ctx;
  const w = c.width;
  const h = c.height;
  const vw = EYE.video ? EYE.video.videoWidth : 0;
  const vh = EYE.video ? EYE.video.videoHeight : 0;

  if (!lm) {
    // no face on screen — clear to a dim panel
    if (EYE.video && EYE.video.readyState >= 2) {
      ctx.drawImage(EYE.video, 0, 0, vw, vh, 0, 0, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
    }
    return;
  }

  // Crop a padded box around the face from the captured screen frame, so the
  // HUD shows the user's face (not the whole desktop) with the mesh on top.
  const bb = faceBBox(lm);
  const pad = Math.max(0.06, Math.max(bb.w, bb.h) * 0.35);
  const cx = Math.max(0, bb.x - pad);
  const cy = Math.max(0, bb.y - pad);
  const cw = Math.min(1 - cx, bb.w + pad * 2);
  const ch = Math.min(1 - cy, bb.h + pad * 2);

  if (EYE.video && EYE.video.readyState >= 2 && vw && vh) {
    ctx.drawImage(EYE.video, cx * vw, cy * vh, cw * vw, ch * vh, 0, 0, w, h);
  } else {
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
  }

  // map a normalized-landmark to canvas coords inside the crop
  const map = (p) => (p ? { x: ((p.x - cx) / cw) * w, y: ((p.y - cy) / ch) * h } : null);

  ctx.lineWidth = 1;
  // draw eye boxes
  const boxes = [
    [L.leftEyeInner, L.leftEyeOuter, L.leftLidTop, L.leftLidBottom],
    [L.rightEyeInner, L.rightEyeOuter, L.rightLidTop, L.rightLidBottom],
  ];
  for (const [a, b] of boxes) {
    const pa = map(lm[a]);
    const pb = map(lm[b]);
    if (!pa || !pb) continue;
    ctx.strokeRect(Math.min(pa.x, pb.x), Math.min(pa.y, pb.y), Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
  }
  // full face-mesh overlay: jaw, eyes, brows, nose, lips — all connected
  const line = (pts, closed) => {
    ctx.beginPath();
    let started = false;
    for (const idx of pts) {
      const p = map(lm[idx]);
      if (!p) continue;
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    if (closed && started) ctx.closePath();
    ctx.stroke();
  };
  const jaw = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 13, 82, 21, 54, 63, 10];
  const leye = [33, 7, 163, 144, 145, 159, 212, 223];
  const reye = [362, 382, 381, 467, 466, 389, 374, 390];
  const lbrow = [105, 66, 10, 336, 296];
  const rbrow = [334, 293, 334, 293, 300, 453, 354];
  const noseBr = [6, 195, 4, 129, 10, 50];
  const noseTi = [28, 168, 134, 352, 37, 8, 17, 86];
  const lipOut = [61, 185, 40, 39, 37, 0, 267, 269, 290];
  const lipIn = [78, 191, 80, 81, 82, 174, 276, 308, 409, 415, 314, 405, 87, 178, 88, 95];
  ctx.lineWidth = 1;
  ctx.strokeStyle = EYE.state.blink ? 'rgba(255,107,107,0.7)' : 'rgba(78,205,196,0.7)';
  line(jaw, true);
  line(leye, true);
  line(reye, true);
  line(lbrow, false);
  line(rbrow, false);
  line(noseBr, false);
  line(noseTi, true);
  ctx.strokeStyle = EYE.state.blink ? 'rgba(255,107,107,0.8)' : 'rgba(255,209,102,0.8)';
  line(lipOut, true);
  line(lipIn, true);
  // gaze vector from nose — where the eyes are actually pointing
  const nose = map(lm[L.noseTip]);
  if (nose) {
    const gx = nose.x + EYE.state.gazeX * 40;
    const gy = nose.y + EYE.state.gazeY * 40;
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nose.x, nose.y);
    ctx.lineTo(gx, gy);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(gx, gy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- screen-based capture (no webcam) ----------
// Glance never opens the camera. It captures the screen, where Teams / Zoom /
// the browser already show your camera. That removes the camera conflict with
// those apps entirely: the physical camera is only ever used by them.
function scheduleCaptureRetry(reason) {
  if (!EYE.wantOn || EYE.retryTimer) return;
  EYE.retryTimer = setTimeout(() => {
    EYE.retryTimer = 0;
    if (EYE.wantOn && !EYE.on && !EYE.busy) startEye();
  }, 3000);
  mpStatus('Screen capture busy — retrying automatically (' + (reason || 'retry') + ')', false);
}

async function openScreenStream() {
  // getDisplayMedia is served by the main-process handler (no picker). Video
  // only; the system-audio Listen path requests audio separately.
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 30 } },
    audio: false,
  });
}

async function startEye() {
  if (EYE.busy || EYE.on) return;
  EYE.wantOn = true;
  EYE.busy = true;
  try {
    if (!EYE.video) {
      EYE.video = document.createElement('video');
      EYE.video.playsInline = true;
      EYE.video.muted = true;
      EYE.video.setAttribute('playsinline', '');
    }
    const stream = await openScreenStream();
    EYE.stream = stream;
    // The user can stop the OS screen-share at any time; end gracefully.
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => {
        if (!EYE.wantOn || EYE.stream !== stream) return;
        EYE.on = false;
        cancelAnimationFrame(EYE.raf);
        EYE.stream = null;
        EYE.state = { ...EYE.state, visible: false, faceCount: 0, attention: 0 };
        scheduleCaptureRetry('screen share ended');
      });
    }
    EYE.video.srcObject = stream;
    await EYE.video.play();
    await new Promise((res) => {
      if (EYE.video.videoWidth) return res();
      EYE.video.addEventListener('loadedmetadata', res, { once: true });
      setTimeout(res, 4000);
    });
    if (!EYE.canvas) EYE.canvas = document.createElement('canvas');
    EYE.canvas.width = 160;
    EYE.canvas.height = 160;
    EYE.ctx = EYE.canvas.getContext('2d');
    await ensureLandmarker();
    EYE.on = true;
    EYE._attnHist = [];
    mpStatus('Eye morph active (screen)');
    EYE.raf = requestAnimationFrame(frameTick);
  } catch (e) {
    // 'NotAllowedError' = capture blocked or cancelled; retry while still wanted
    scheduleCaptureRetry(e && e.name ? e.name : 'capture failed');
  } finally {
    EYE.busy = false;
  }
}

function stopEye() {
  EYE.on = false;
  EYE.wantOn = false;
  if (EYE.retryTimer) {
    clearTimeout(EYE.retryTimer);
    EYE.retryTimer = 0;
  }
  cancelAnimationFrame(EYE.raf);
  if (EYE.stream) {
    EYE.stream.getTracks().forEach((t) => t.stop());
    EYE.stream = null;
  }
  EYE.state = { visible: false, gazeX: 0, gazeY: 0, blink: false, attention: 0, faceCount: 0 };
  EYE._attnHist = [];
  mpStatus('Eye morph off');
}

// return a short text descriptor of current gaze, for prompt injection
function gazeDescriptor() {
  const s = EYE.state;
  if (!s.visible) return 'No face detected on screen (camera preview may be hidden).';
  const parts = [];
  parts.push(s.blink ? 'blinking' : 'eyes open');
  const dx = s.gazeX;
  const dy = s.gazeY;
  if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.3) parts.push('looking straight at screen');
  else if (dx < -0.3) parts.push('looking left');
  else if (dx > 0.3) parts.push('looking right');
  if (dy < -0.3) parts.push('looking up');
  else if (dy > 0.3) parts.push('looking down');
  const attn = Math.round(s.attention * 100);
  parts.push('attention ~' + attn + '%');
  return 'Eye tracking: face visible, ' + parts.join(', ') + '.';
}

window.glanceEye = {
  get on() {
    return EYE.on;
  },
  get state() {
    return EYE.state;
  },
  start: startEye,
  stop: stopEye,
  toggle: () => (EYE.on ? stopEye() : startEye()),
  gazeDescriptor,
  get defaultOn() {
    return EYE.defaultOn;
  },
  get busy() {
    return EYE.busy;
  },
  get canvas() {
    return EYE.canvas;
  },
  setOnStatus(cb) {
    EYE.onStatus = cb;
  },
  setOnFrame(cb) {
    EYE.onFrame = cb;
  },
  autoStart() {
    if (EYE.defaultOn) startEye();
  },
  // Backwards-compatible stubs: the morph is screen-based now, so there are no
  // cameras to list or switch. Kept so older callers don't throw.
  listCameras() {
    return Promise.resolve([]);
  },
  get cameraId() {
    return 'screen';
  },
  setCameraId() {},
  async setCamera() {
    return { ok: EYE.on, restarted: false };
  },
};
