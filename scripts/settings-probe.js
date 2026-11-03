'use strict';
// Drive the real settings form in the running app: open Settings, choose a style,
// enter a backup key, save, then read the config back.
// plain `node` cannot use the Electron API: re-exec under the bundled binary
const electronModule = require('electron');
if (typeof electronModule === 'string') {
  const { spawnSync } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  process.exit(spawnSync(electronModule, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env }).status ?? 1);
}

const { app } = require('electron');
const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.CDP_PORT || 9333);

const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let raw = ''; r.on('data', (c) => raw += c); r.on('end', () => { try { res(JSON.parse(raw)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
function cdp(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } });
    req.on('upgrade', (_res, socket) => {
      let id = 0; const pending = new Map(); let buf = Buffer.alloc(0);
      const sendFrame = (text) => {
        const payload = Buffer.from(text); const mask = crypto.randomBytes(4);
        let header;
        if (payload.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | payload.length; }
        else { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
        header[0] = 0x81;
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        socket.write(Buffer.concat([header, mask, payload]));
      };
      const feed = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const len0 = buf[1] & 0x7f; let off = 2, len = len0;
          if (len0 === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len0 === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const body = buf.subarray(off, off + len).toString(); buf = buf.subarray(off + len);
          try { const m = JSON.parse(body); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
        }
      };
      socket.on('data', feed); socket.on('error', reject);
      resolve((expr) => new Promise((res) => {
        const i = ++id; pending.set(i, (m) => res(m.result));
        sendFrame(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true } }));
      }));
    });
    req.on('error', reject); req.end();
  });
}

app.whenReady().then(async () => {
  try {
    const targets = await getJson('/json/list');
    const t = targets.find((k) => k.type === 'page' && k.url.includes('renderer'));
    if (!t) throw new Error('no renderer target');
    const ev = await cdp(t.webSocketDebuggerUrl);

    const script = `(async () => {
      document.getElementById('gear').click();
      await new Promise(r => setTimeout(r, 900));
      document.getElementById('s_answerStyle').value = 'bullets';
      document.getElementById('s_fallbackBaseUrl').value = 'https://backup.example/v1';
      document.getElementById('s_fallbackApiKey').value = 'bk-test-123';
      const opts = document.getElementById('s_answerStyle').options.length;
      document.getElementById('s_save').click();
      await new Promise(r => setTimeout(r, 1600));
      const c = await window.glance.getConfig();
      document.getElementById('s_close').click();
      return JSON.stringify({
        styleOptions: opts,
        savedStyle: c.answerStyle,
        hasFallbackKey: c.hasFallbackKey,
        fallbackBaseUrl: c.fallbackBaseUrl,
        msg: document.getElementById('s_msg').textContent,
      });
    })()`;
    const r = await ev(script);
    console.log(r.result.value);
    const v = JSON.parse(r.result.value);
    const good = v.styleOptions === 6 && v.savedStyle === 'bullets' && v.hasFallbackKey === true;
    console.log(good ? 'PASS' : 'FAIL');
    app.exit(good ? 0 : 1);
  } catch (e) { console.error('ERR:', e.message); app.exit(1); }
});
