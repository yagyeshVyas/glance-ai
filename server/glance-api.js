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
      upstream: { chat: Boolean(chat.base), transcription: Boolean(stt.base), speech: Boolean(upstream('tts').base) },
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

  if (p === '/v1/audio/transcriptions' && req.method === 'POST') return proxy('stt', '/audio/transcriptions', req, res);
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
  console.log(`  transcription ${stt.base ? stt.base : 'NOT CONFIGURED'}`);
  console.log(`  speech        ${upstream('tts').base ? upstream('tts').base : 'not configured'}`);
  log(`listen ${PORT}`);
});

function shutdown() {
  try { fs.unlinkSync(PID_FILE); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
