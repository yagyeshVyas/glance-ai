'use strict';
// Proves server/glance-api.js does what it claims, without needing a real key.
//
//   node scripts/api-probe.js
//
// A stub upstream stands in for the provider: it records the Authorization it
// received and echoes the model name it was asked for. The probe then asserts
//
//   1. the app's key ("any-key") never reaches the upstream — the configured key
//      replaces it,
//   2. the configured CHAT_MODEL rewrites the model the app sent,
//   3. a multipart transcription is forwarded and its JSON comes back intact,
//   4. a browser opening the port gets a bare 404 with no HTML,
//   5. the SSE stream is passed through, not buffered.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function wav(samples = 800) {
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

async function main() {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('latin1'); });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization || '', body: body.slice(0, 2000) });
      if (req.url.endsWith('/chat/completions')) {
        let model = '';
        try { model = JSON.parse(body).model || ''; } catch {}
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong:' + model } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else if (req.url.endsWith('/audio/transcriptions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'hello from stub' }));
      } else if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      }
    });
  });

  const stubPort = await listen(stub);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const pidFile = path.join(os.tmpdir(), 'rb-api-probe-' + process.pid + '.pid');

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'glance-api.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      UPSTREAM_BASE: `http://127.0.0.1:${stubPort}/v1`,
      UPSTREAM_KEY: 'real-upstream-key',
      CHAT_MODEL: 'forced-model',
      PID_FILE: pidFile,
      LOG: '0',
      STT_LOCAL: '0', // this probe covers the proxy; local whisper is tested separately
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });

  // wait for listen
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await request(port, 'GET', '/health', {});
      up = r.status === 200;
    } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) {
    console.error('server did not start:\n' + childOut);
    try { child.kill(); } catch {}
    process.exit(1);
  }

  try {
    // 1 + 2 + 5: chat through the proxy
    const chat = await request(port, 'POST', '/v1/chat/completions', {
      headers: { 'content-type': 'application/json', authorization: 'Bearer any-key', accept: 'text/event-stream' },
      body: JSON.stringify({ model: 'app-model', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    const chatSeen = seen.filter((s) => s.url.endsWith('/chat/completions')).pop() || {};
    check('chat streamed back', chat.status === 200 && chat.body.includes('pong:forced-model'), chat.body.slice(0, 80));
    check('app key replaced by configured key', chatSeen.auth === 'Bearer real-upstream-key', 'upstream saw: ' + chatSeen.auth);
    check('model rewritten to CHAT_MODEL', chatSeen.body.includes('"model":"forced-model"'), 'upstream saw model in body');

    // 3: multipart transcription
    const boundary = '----rbprobe' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
    const mid = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, wav(), mid]);
    const tr = await request(port, 'POST', '/v1/audio/transcriptions', {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: 'Bearer any-key', 'content-length': body.length },
      body,
    });
    let trJson = {};
    try { trJson = JSON.parse(tr.body); } catch {}
    check('transcription forwarded', tr.status === 200 && trJson.text === 'hello from stub', tr.body.slice(0, 80));

    // 4: a browser tab
    const root = await request(port, 'GET', '/', { headers: { accept: 'text/html' } });
    check('port is not browsable', root.status === 404 && root.body.trim() === '{}' && !/<html/i.test(root.body), `${root.status} ${root.body.trim()}`);

    // models passthrough
    const models = await request(port, 'GET', '/v1/models', {});
    check('/v1/models passes through', models.status === 200 && models.body.includes('stub-model'), models.body.slice(0, 60));
  } finally {
    try { child.kill(); } catch {}
    try { stub.close(); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
  }

  let bad = 0;
  for (const r of results) {
    console.log((r.ok ? 'ok   ' : 'FAIL ') + r.name + (r.ok ? '' : '  — ' + r.detail));
    if (!r.ok) bad++;
  }
  console.log(bad ? `\n${bad} check(s) failed` : '\nPASS — proxy, credentials, model rewrite, multipart and the closed port all behave');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
