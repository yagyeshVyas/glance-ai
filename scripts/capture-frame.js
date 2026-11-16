'use strict';
// Save one screen frame the way the app's own screenshot path produces it.
//
//   node scripts/capture-frame.js [out.jpg] [--port 9333]
//
// The point is to look at the file: the panel must be *in* the frame even
// though capture protection is on, because `captureScreen()` composites the
// panel back from the renderer instead of dropping protection for the grab.
// A frame without the panel means the compositing silently failed, and the app
// would answer questions about a screen it cannot see.

const fs = require('fs');
const path = require('path');
const { list, evaluate } = require('./cdp-eval');

async function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--port');
  const port = Number(pi >= 0 ? argv[pi + 1] : (process.env.CDP_PORT || 9333));
  const out = path.resolve(argv.filter((a, i) => a !== '--port' && !(pi >= 0 && i === pi + 1))[0] ||
    path.join(require('os').tmpdir(), 'rb-frame.jpg'));

  const targets = await list(port);
  const page = targets.find((t) => t.type === 'page' && /index\.html|renderer/i.test(t.url || '')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + port);

  const res = await evaluate(page.webSocketDebuggerUrl,
    '(async()=>{const r=await window.glance.captureOne();return r && r.b64 ? r.b64 : "";})()');
  const b64 = res && 'value' in res ? res.value : res;
  if (!b64) throw new Error('captureOne returned no image');
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(out + '  ' + (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
