'use strict';
// Stand-alone frame producer for the vendored UnityCapture virtual camera.
//
// Compiles src/vcam/sender.cs (in-box csc, hash-cached), starts it, and feeds
// it an animated RGBA test pattern over the named pipe. This proves the whole
// transport without any app code: register the camera, run this, open the
// device in any app, and the pattern is what the app receives.
//
// Run: node scripts/vcam-pattern.js [--seconds 20] [--pipe glance-vcam] [--size 640x480]
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const seconds = Number(arg('seconds', 0)) || 0;
const pipeName = arg('pipe', 'glance-vcam');
const [W, H] = String(arg('size', '640x480')).split('x').map(Number);
const FPS = 15;
const solid = (() => { const i = argv.indexOf('--solid'); if (i < 0) return null; const [r,g,b] = String(argv[i+1]).split(',').map(Number); return [r,g,b]; })();

function csc() {
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  return fs.existsSync(p) ? p : null;
}

function buildSender() {
  const src = path.join(__dirname, '..', 'src', 'vcam', 'sender.cs');
  const code = fs.readFileSync(src);
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), 'wshx-vcam');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'vcam-sender-' + hash + '.exe');
  if (!fs.existsSync(exe)) {
    const compiler = csc();
    if (!compiler) throw new Error('csc.exe not found');
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/out:' + exe, src], { stdio: 'pipe' });
  }
  return exe;
}

function patternFrame(t, buf) {
  if (solid) { for (let i = 0; i < buf.length; i += 4) { buf[i]=solid[0]; buf[i+1]=solid[1]; buf[i+2]=solid[2]; buf[i+3]=255; } return buf; }
  const stride = W * 4;
  const shift = Math.floor((t / 40) % (W + 160)) - 160;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * stride + x * 4;
      const inBox = x > shift && x < shift + 120 && y > H / 2 - 80 && y < H / 2 + 80;
      if (inBox) {
        buf[i] = 255; buf[i + 1] = 64; buf[i + 2] = 16; buf[i + 3] = 255;
      } else {
        // color bars: R by x, G by y, B pulsing with time
        buf[i] = (x * 255 / W) | 0;
        buf[i + 1] = (y * 255 / H) | 0;
        buf[i + 2] = ((Math.sin(t / 300) + 1) * 90) | 0;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

const exe = buildSender();
const sender = spawn(exe, [pipeName], { stdio: 'inherit', windowsHide: true });

let frameBuf = Buffer.alloc(W * H * 4);
let served = 0;
const server = net.createServer((socket) => {
  console.log('producer: sender connected to \\\\.\\pipe\\' + pipeName);
  const header = Buffer.alloc(16);
  let timer = null;
  const tick = () => {
    const t = Date.now();
    patternFrame(t, frameBuf);
    header.writeInt32LE(W, 0);
    header.writeInt32LE(H, 4);
    header.writeInt32LE(W * 4, 8);
    header.writeInt32LE(0, 12); // FORMAT_UINT8
    const ok = socket.write(Buffer.concat([header, frameBuf]));
    served++;
    if (!ok) return; // backpressure: skip until drained
  };
  timer = setInterval(tick, Math.round(1000 / FPS));
  socket.on('error', () => {});
  socket.on('close', () => {
    clearInterval(timer);
    console.log('producer: sender disconnected after ' + served + ' frames');
    if (!seconds) server.close();
  });
  tick();
});

server.listen('\\\\.\\pipe\\' + pipeName, () => {
  console.log(`producer: ${W}x${H} RGBA @ ${FPS} fps on \\\\.\\pipe\\${pipeName}; sender pid ${sender.pid}`);
});

const shut = () => {
  try { sender.kill(); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shut);
process.on('SIGTERM', shut);
if (seconds) setTimeout(shut, seconds * 1000);

