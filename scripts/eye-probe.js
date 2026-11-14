'use strict';
// Headless check of the eye-tracking math in src/renderer/eye.js.
//
// The renderer file is a plain script, so this loads it in a VM with a stub
// window and calls the pure functions with synthetic 478-point landmarks. It
// exists because the two bugs that made the HUD show a black tile and stay red
// were both in this math, and neither needs a camera or a face to catch:
//
//   1. MediaPipe returns normalized landmarks; norm() divided by videoWidth /
//      videoHeight again, collapsing the face crop and pinning gaze at zero.
//   2. Blink divided lid gap by face height, which never crossed the threshold —
//      the HUD was permanently "blinking" and the attention score penalised.
//
// Run: node scripts/eye-probe.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'eye.js'), 'utf8');
const sandbox = {
  window: {},
  document: { createElement: () => ({}) },
  performance: { now: () => 0 },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
};
const exported = `
;globalThis.__eye = { norm, estimateGaze, estimateBlink, faceBBox, pickLargestFace, L };
`;
vm.runInNewContext(src + exported, sandbox, { filename: 'eye.js' });
const E = sandbox.__eye;

let bad = 0;
const ok = (label, cond, detail) => {
  if (cond) return console.log('ok   ' + label);
  bad++;
  console.error('FAIL ' + label + (detail ? ' — ' + detail : ''));
};

// A neutral face on a 1920x1080 frame: landmarks normalized 0..1, eyes roughly
// in the middle of the image, irises centred in each eye.
function face({ irisShift = 0, lidGap = 0.02 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const set = (id, x, y) => { lm[id] = { x, y }; };
  // left eye (image left): corners .40 / .45, lids .40 / .40+lidGap, iris centre
  set(E.L.leftCornerOuter, 0.40, 0.41);
  set(E.L.leftCornerInner, 0.45, 0.41);
  set(E.L.leftLidTop, 0.40, 0.40);
  lm[E.L.leftLidBottom] = { x: 0.475, y: 0.40 + lidGap };
  for (const id of E.L.leftIris) set(id, 0.425 + irisShift, 0.40 + lidGap / 2);
  // right eye (image right): corners .55 / .50, same vertical geometry
  set(E.L.rightCornerOuter, 0.55, 0.41);
  set(E.L.rightCornerInner, 0.50, 0.41);
  set(E.L.rightLidTop, 0.50, 0.40);
  lm[E.L.rightLidBottom] = { x: 0.525, y: 0.40 + lidGap };
  for (const id of E.L.rightIris) set(id, 0.525 + irisShift, 0.40 + lidGap / 2);
  return lm;
}

// 1. norm() must not rescale: a normalized 0.25 stays 0.25 regardless of frame.
const p = E.norm({ x: 0.25, y: 0.75 });
ok('norm() is already normalized', p.x === 0.25 && p.y === 0.75, JSON.stringify(p));

// 2. centred irises read as centred gaze
const g0 = E.estimateGaze(face());
ok('centred irises -> gaze ~0', g0 && Math.abs(g0.x) < 0.06 && Math.abs(g0.y) < 0.06, JSON.stringify(g0));
ok('iris path is used on a 478-point mesh', Boolean(g0 && g0.iris));

// 3. both irises shifted toward image-right read positive (looking right)
const gR = E.estimateGaze(face({ irisShift: 0.015 }));
ok('irises right -> gaze > 0.4', gR && gR.x > 0.4, JSON.stringify(gR));

// 4. blink: open lid gap 0.02 / eye width 0.05 = 0.4 -> open; closed 0.002 -> blink
ok('open eye is not a blink', E.estimateBlink(face({ lidGap: 0.02 })) === false);
ok('closed eye is a blink', E.estimateBlink(face({ lidGap: 0.002 })) === true);

// 5. the face box is in normalized image space, not a few pixels in the corner
const bb = E.faceBBox(face());
ok('face box spans a real region', bb.w > 0.1 && bb.h > 0.0, JSON.stringify(bb));

// 6. a small self-view in the bottom-right wins over a large interviewer tile
const self = face();
for (const pt of self) { pt.x = 0.8 + (pt.x - 0.5) * 0.25; pt.y = 0.7 + (pt.y - 0.5) * 0.25; }
const other = face();
const picked = E.pickLargestFace([other, self]);
ok('self-view preferred over the largest tile', picked === self);

// 7. single face still tracks
ok('single face still tracks', E.pickLargestFace([self]) === self);

console.log(bad ? bad + ' eye checks failed' : 'all eye checks passed');
process.exit(bad ? 1 : 0);
