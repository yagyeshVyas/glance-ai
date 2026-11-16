'use strict';
// Glance local API — one OpenAI-compatible endpoint on 127.0.0.1 that the app
// can point at with any key at all.
//
// Why it exists: a self-hosted gateway often implements /chat/completions and
// nothing else, while the app also needs /audio/transcriptions (and optionally
// /audio/speech). This process sits between the app and whatever upstreams you
// configure, so the app only ever sees one base URL:
//
//     http://127.0.0.1:47821/v1
//
// The key the app sends is ignored on purpose — "anykey" works — and the real
// credentials live in server/.env, which is never committed. That means a build
// can be handed to someone else without a key in it, and the key can be rotated
// without touching the app.
//
// Binding: 127.0.0.1 only. Nothing on the network can reach it, and a browser
// tab opened on the port gets a bare 404 with no HTML and no title, because
// there is nothing to show.
//
//   node server/glance-api.js            foreground
//   start-api.cmd                        hidden, via the .vbs launcher
//
// Config (server/.env, KEY=VALUE, all optional):
//   PORT=47821
//   UPSTREAM_BASE=https://api.example.com/v1
//   UPSTREAM_KEY=sk-...
//   CHAT_MODEL=                  rewrite the model name the app sends
//   STT_BASE=                    separate provider for /audio/transcriptions
//   STT_KEY=
//   STT_MODEL=
//   TTS_BASE= / TTS_KEY= / TTS_MODEL=
//   LOG=1                        append request lines to server/logs/api.log

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 0) || 47821;
const HOST = '127.0.0.1';
const RUN_DIR = path.join(ROOT, 'run');
const LOG_DIR = path.join(ROOT, 'logs');
const PID_FILE = process.env.PID_FILE ? path.resolve(process.env.PID_FILE) : path.join(RUN_DIR, 'api.pid');
const LOG_FILE = path.join(LOG_DIR, 'api.log');

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {}
  return out;
}

const env = { ...loadEnvFile(), ...process.env };
const LOG_ON = String(env.LOG || '0') === '1';

// Local Whisper: on by default, because a gateway with no /audio/transcriptions
// is the common case and a transcript that silently stays empty is worse than one
// produced on this machine. Set STT_LOCAL=0 to proxy to STT_BASE instead.
const STT_LOCAL = String(env.STT_LOCAL === undefined ? '1' : env.STT_LOCAL) !== '0';
const WORKER = path.join(ROOT, 'stt-worker.py');

function upstream(kind) {
  const shared = { base: env.UPSTREAM_BASE || '', key: env.UPSTREAM_KEY || '' };
  if (kind === 'stt') {
    return { base: env.STT_BASE || shared.base, key: env.STT_KEY || shared.key, model: env.STT_MODEL || '' };
  }
  if (kind === 'tts') {
    return { base: env.TTS_BASE || shared.base, key: env.TTS_KEY || shared.key, model: env.TTS_MODEL || '' };
  }
  return { ...shared, model: env.CHAT_MODEL || '' };
}

function log(line) {
  if (!LOG_ON) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const size = (() => { try { return fs.statSync(LOG_FILE).size; } catch { return 0; } })();
    if (size > 5 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': buf.length,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(buf);
}

// Hop-by-hop headers must not be forwarded; content-length is recomputed by Node.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

function forwardHeaders(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function proxy(kind, upstreamPath, req, res, body) {
  const up = upstream(kind);
  if (!up.base) {
    return json(res, 501, {
      error: {
        message: `glance-api: no upstream configured for ${kind}. Set ${kind === 'chat' ? 'UPSTREAM_BASE' : kind.toUpperCase() + '_BASE'} in server/.env`,
        type: 'configuration_error',
      },
    });
  }

  let target;
  try {
    target = new URL(up.base.replace(/\/+$/, '') + upstreamPath);
  } catch (e) {
    return json(res, 501, { error: { message: 'glance-api: UPSTREAM_BASE is not a URL: ' + up.base, type: 'configuration_error' } });
  }

  const headers = forwardHeaders(req.headers);
  if (up.key) headers.authorization = `Bearer ${up.key}`;
  if (body) headers['content-length'] = String(body.length);

  const started = Date.now();
  const preq = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    method: req.method,
    headers,
  }, (pres) => {
    const outHeaders = forwardHeaders(pres.headers);
    res.writeHead(pres.statusCode || 502, outHeaders);
    pres.pipe(res);
    pres.on('end', () => log(`${kind} ${req.method} ${upstreamPath} -> ${pres.statusCode} ${Date.now() - started}ms`));
  });

  preq.setTimeout(120000, () => { try { preq.destroy(new Error('upstream timeout')); } catch {} });
  preq.on('error', (e) => {
    log(`${kind} ${req.method} ${upstreamPath} -> error ${e.message}`);
    if (!res.headersSent) json(res, 502, { error: { message: 'glance-api: upstream failed: ' + e.message, type: 'upstream_error' } });
    else try { res.destroy(); } catch {}
  });

  if (body) preq.end(body);
  else req.pipe(preq);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- local whisper worker ----------
// One process, model loaded once, one JSON line per chunk. Spawning Python per
// request would reload the model every 4 seconds and the transcript would always
// be behind the conversation.
const worker = { proc: null, booting: null, seq: 0, waiting: new Map(), lastError: '' };

function pythonCandidates() {
  if (env.PYTHON) return [{ cmd: env.PYTHON, args: [] }];
  if (process.platform === 'win32') return [{ cmd: 'python', args: [] }, { cmd: 'py', args: ['-3'] }];
  return [{ cmd: 'python3', args: [] }];
}

function bootWorker() {
  if (worker.booting) return worker.booting;
  worker.booting = new Promise((resolve, reject) => {
    const candidates = pythonCandidates();
    const tryNext = (i) => {
      if (i >= candidates.length) return reject(new Error(worker.lastError || 'no python found'));
      const { cmd, args } = candidates[i];
      const proc = spawn(cmd, [...args, WORKER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env } });
      let buffered = '';
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        worker.lastError = err.message;
        try { proc.kill(); } catch {}
        tryNext(i + 1);
      };
      proc.on('error', fail);
      proc.stdout.on('data', (d) => {
        buffered += d.toString('utf8');
        let nl;
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.ready === true && !settled) {
            settled = true;
            worker.proc = proc;
            log('stt worker ready ' + JSON.stringify({ model: msg.model, load_ms: msg.load_ms }));
            resolve(proc);
          } else if (msg.ready === false && !settled) {
            fail(new Error(msg.error || 'worker refused to start'));
          } else if (msg.id !== undefined && worker.waiting.has(msg.id)) {
            const done = worker.waiting.get(msg.id);
            worker.waiting.delete(msg.id);
            done(msg);
          }
        }
      });
      proc.stderr.on('data', (d) => { worker.lastError = String(d).slice(0, 300); });
      proc.on('exit', () => {
        worker.proc = null;
        worker.booting = null;
        for (const [, done] of worker.waiting) done({ error: 'worker exited' });
        worker.waiting.clear();
      });
    };
    tryNext(0);
  });
  return worker.booting;
}

function workerAsk(file) {
  return bootWorker().then((proc) => new Promise((resolve) => {
    const id = ++worker.seq;
    const timer = setTimeout(() => {
      worker.waiting.delete(id);
      resolve({ error: 'transcription timed out' });
    }, 60000);
    worker.waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    try { proc.stdin.write(JSON.stringify({ id, path: file, cleanup: true }) + '\n'); }
    catch (e) { clearTimeout(timer); worker.waiting.delete(id); resolve({ error: e.message }); }
  }));
}

// Pull the first part named "file" out of a multipart body. The app posts one
// file and a model field, so a full multipart parser would be more code than the
// request can exercise — but the boundary scan still has to be byte-exact.
function extractFile(body, boundary) {
  const delim = Buffer.from('--' + boundary);
  let at = body.indexOf(delim);
  while (at >= 0) {
    const after = at + delim.length;
    if (body.slice(after, after + 2).toString() === '--') return null;
    const headerEnd = body.indexOf('\r\n\r\n', after);
    if (headerEnd < 0) return null;
    const headers = body.slice(after, headerEnd).toString('utf8');
    const next = body.indexOf(delim, headerEnd);
    if (next < 0) return null;
    if (/name="file"/i.test(headers)) {
      let dataStart = headerEnd + 4;
      let dataEnd = next;
      if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
      return { data: body.slice(dataStart, dataEnd), type: type ? type[1].trim().toLowerCase() : 'audio/webm' };
    }
    at = next;
  }
  return null;
}

function extFor(type) {
  if (type.includes('wav')) return '.wav';
  if (type.includes('ogg')) return '.ogg';
  if (type.includes('mpeg') || type.includes('mp3')) return '.mp3';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return '.m4a';
  if (type.includes('flac')) return '.flac';
  return '.webm';
}

async function transcribeLocally(req, res) {
  const raw = await readBody(req).catch(() => null);
  if (!raw) return json(res, 400, { error: { message: 'glance-api: unreadable request body' } });
  const ct = String(req.headers['content-type'] || '');
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
  if (!m) return json(res, 400, { error: { message: 'glance-api: expected a multipart body' } });
  const part = extractFile(raw, (m[1] || m[2]).trim());
  if (!part || !part.data.length) return json(res, 400, { error: { message: 'glance-api: no audio part in the request' } });

  const tmp = path.join(require('os').tmpdir(), 'glance-stt-' + process.pid + '-' + (++worker.seq) + extFor(part.type));
  try { fs.writeFileSync(tmp, part.data); } catch (e) {
    return json(res, 500, { error: { message: 'glance-api: cannot write temp audio: ' + e.message } });
  }

  const started = Date.now();
  let out;
  try {
    out = await workerAsk(tmp);
  } catch (e) {
    out = { error: e && e.message ? e.message : String(e) };
  }
  if (out.error) {
    try { fs.unlinkSync(tmp); } catch {}
    log('stt local -> error ' + out.error);
    return json(res, 502, { error: { message: 'glance-api: local transcription failed: ' + out.error, type: 'stt_error' } });
  }
  log('stt local ' + part.data.length + 'B -> ' + JSON.stringify(out.text || '').slice(0, 60) + ' ' + (Date.now() - started) + 'ms');
  return json(res, 200, { text: out.text || '' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  if (p === '/health' || p === '/v1/health') {
    const chat = upstream('chat');
    const stt = upstream('stt');
    return json(res, 200, {
      ok: true,
      port: PORT,
      uptime: Math.round(process.uptime()),
      upstream: { chat: Boolean(chat.base), transcription: STT_LOCAL ? 'local' : Boolean(stt.base), speech: Boolean(upstream('tts').base) },
    });
  }

  if (p === '/v1/models' && req.method === 'GET') return proxy('chat', '/models', req, res);

  if (p === '/v1/chat/completions' && req.method === 'POST') {
    // A model override needs the JSON body in hand; anything else streams through.
    const isJson = String(req.headers['content-type'] || '').includes('application/json');
    const model = upstream('chat').model;
    if (isJson && model) {
      const raw = await readBody(req).catch(() => null);
      if (!raw) return json(res, 400, { error: { message: 'glance-api: unreadable request body' } });
      let parsed = null;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch {}
      if (parsed && typeof parsed === 'object') parsed.model = model;
      return proxy('chat', '/chat/completions', req, res, Buffer.from(JSON.stringify(parsed || {})));
    }
    return proxy('chat', '/chat/completions', req, res);
  }

  if (p === '/v1/audio/transcriptions' && req.method === 'POST') {
    if (STT_LOCAL) return transcribeLocally(req, res);
    return proxy('stt', '/audio/transcriptions', req, res);
  }
  if (p === '/v1/audio/speech' && req.method === 'POST') return proxy('tts', '/audio/speech', req, res);

  // Nothing here is meant to be browsed: a tab on this port shows an empty 404,
  // no HTML, no title, no product name.
  res.writeHead(404, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
  res.end('{}');
});

function alreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return pid;
  } catch {
    return false;
  }
}

const running = alreadyRunning();
if (running) {
  console.log(`glance-api: already running (pid ${running}) on http://${HOST}:${PORT}`);
  process.exit(0);
}

server.listen(PORT, HOST, () => {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}
  const chat = upstream('chat');
  const stt = upstream('stt');
  console.log(`glance-api: http://${HOST}:${PORT}/v1  pid ${process.pid}`);
  console.log(`  chat          ${chat.base ? chat.base : 'NOT CONFIGURED'}`);
  console.log(`  transcription ${STT_LOCAL ? 'local whisper (stt-worker.py)' : (stt.base ? stt.base : 'NOT CONFIGURED')}`);
  console.log(`  speech        ${upstream('tts').base ? upstream('tts').base : 'not configured'}`);
  log(`listen ${PORT}`);
});

function shutdown() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
// A rejected promise inside an async request handler would otherwise take the
// process down and reset every in-flight request — including the ones that were
// fine. Log it and keep serving.
process.on('unhandledRejection', (e) => {
  log('unhandledRejection ' + (e && e.message ? e.message : String(e)));
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
