'use strict';
// NVIDIA Broadcast gateway client for Glance.
//
// Broadcast 2.3+ exposes the app's effects over an unauthenticated loopback MCP
// server (Streamable HTTP): set_effects with effectId "eye_contact", plus
// get_broadcast_state, list_devices, set_active_device and file processing.
// That is the only supported way to get NVIDIA's eye-contact model into another
// app; the model itself is inside NvBroadcastCore.dll (Maxine AR / NvAR) and is
// not redistributable, so this drives Broadcast rather than copying it.
//
// Everything here is best-effort: no gateway means Broadcast is not running and
// every call resolves to { ok:false, reason }, never a throw into the app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PROTOCOL = '2025-03-26';
const CLIENT = { name: 'glance-ai', version: '3.0.1' };
const EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVIDIA Broadcast', 'NVIDIA Broadcast.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appDataPath() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// gateway.json holds base64 JSON {port}. The port can move across 18100-18109.
function readGateway() {
  const file = path.join(appDataPath(), 'nvidia-broadcast', 'gateway.json');
  try {
    if (!fs.existsSync(file)) return null;
    const decoded = JSON.parse(Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64').toString('utf8'));
    const port = Number(decoded && decoded.port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? { port, url: 'http://127.0.0.1:' + port + '/gateway' } : null;
  } catch {
    return null;
  }
}

function parseRpcBody(text, contentType) {
  if (!text) return null;
  if ((contentType || '').includes('text/event-stream')) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { return JSON.parse(payload); } catch {}
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function post(url, body, sessionId, timeoutMs = 8000) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { status: res.status, session: res.headers.get('mcp-session-id'), body: parseRpcBody(text, res.headers.get('content-type')) };
}

let cached = null; // { url, session, at }
const SESSION_MS = 30000;

async function openSession(timeoutMs) {
  const gw = readGateway();
  if (!gw) return { ok: false, reason: 'Broadcast is not running' };
  try {
    const init = await post(gw.url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT },
    }, null, timeoutMs);
    const info = init.body && init.body.result && init.body.result.serverInfo;
    if (!info || info.name !== 'nvidia-broadcast') {
      return { ok: false, reason: 'something else answers on port ' + gw.port };
    }
    const session = init.session || null;
    // the spec wants this notification; a server may ignore or 404 it
    try { await post(gw.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, timeoutMs); } catch {}
    return { ok: true, url: gw.url, session, version: info.version || '?' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message).slice(0, 120) };
  }
}

async function session(timeoutMs = 5000) {
  if (cached && Date.now() - cached.at < SESSION_MS) return cached;
  const s = await openSession(timeoutMs);
  if (!s.ok) { cached = null; return s; }
  cached = { ...s, at: Date.now() };
  return cached;
}

async function callTool(name, args = {}, timeoutMs = 12000) {
  const s = await session();
  if (!s.ok) return s;
  try {
    const res = await post(s.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, s.session, timeoutMs);
    const result = res.body && res.body.result;
    if (!result) return { ok: false, reason: 'empty tool result (HTTP ' + res.status + ')' };
    if (result.isError) {
      const text = (result.content || []).map((c) => c.text).filter(Boolean).join(' ');
      return { ok: false, reason: text || 'tool error' };
    }
    return { ok: true, result, structured: result.structuredContent || null };
  } catch (e) {
    cached = null;
    return { ok: false, reason: String(e && e.message).slice(0, 120) };
  }
}

async function listTools() {
  const s = await session();
  if (!s.ok) return s;
  try {
    const res = await post(s.url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, s.session);
    const tools = (res.body && res.body.result && res.body.result.tools) || [];
    return { ok: true, tools: tools.map((t) => t.name) };
  } catch (e) {
    cached = null;
    return { ok: false, reason: String(e && e.message).slice(0, 120) };
  }
}

// Camera effect ids that Broadcast understands (from the shipped skill docs and
// the live tool schema); eye_contact is the one this app drives.
async function getCameraState() {
  const r = await callTool('get_broadcast_state', { effectType: 'camera' });
  if (!r.ok) return r;
  const state = r.structured || r.result || {};
  return { ok: true, state };
}

async function setEyeContact(on) {
  // set_effects schema: { action?, effects: [{ effectId, enabled?, params? }] }
  // — no section/effectType field; the effect id carries its section.
  const r = await callTool('set_effects', {
    effects: [{ effectId: 'eye_contact', enabled: Boolean(on) }],
  });
  if (!r.ok) return r;
  const result = r.structured || {};
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  return { ok: true, success: result.success !== false && skipped.length === 0, skipped, state: result.state || null };
}

async function ensureEyeContact(on = true) {
  const state = await getCameraState();
  if (!state.ok) return state;
  const cam = state.state || {};
  // get_broadcast_state returns the camera section flattened in live builds
  const current = cam.eye_contact ? Boolean(cam.eye_contact.enabled) : null;
  if (current === Boolean(on)) return { ok: true, already: true, enabled: current };
  return setEyeContact(on);
}

async function listDevices() {
  return callTool('list_devices', {});
}

function isRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq NVIDIA Broadcast.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 4000 }, (err, out) => {
        resolve(!err && /NVIDIA Broadcast\.exe/i.test(String(out || '')));
      });
  });
}

async function waitForGateway(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    cached = null;
    const s = await session(2500);
    if (s.ok) return s;
    await sleep(1200);
  }
  return null;
}

async function waitForProcess(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isRunning()) return true;
    await sleep(600);
  }
  return false;
}

// Broadcast must be running for the effect to exist at all — it is the app that
// owns the model and the virtual camera. A window is not required: the app has a
// tray mode and its own hidden-launch argument. On this build the hidden launch
// can exit without starting anything, so if no process appears we fall back to a
// normal shell launch (one visible window, once) rather than leaving the feature
// dead. Never starts a second copy.
async function ensureRunning(timeoutMs = 35000) {
  const s = await session(2500);
  if (s.ok) return { ok: true, already: true };
  if (await isRunning()) {
    const g = await waitForGateway(timeoutMs);
    return g ? { ok: true, already: true } : { ok: false, reason: 'Broadcast is running but its gateway did not answer' };
  }
  if (!fs.existsSync(EXE)) return { ok: false, reason: 'NVIDIA Broadcast is not installed' };
  let startedVisible = false;
  try {
    const child = spawn(EXE, ['--launch-hidden'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {
    // fall through to the visible launch below
  }
  if (!(await waitForProcess(6000))) {
    try {
      execFile('explorer.exe', [EXE], { windowsHide: true, timeout: 5000 }, () => {});
      startedVisible = true;
    } catch (e) {
      return { ok: false, reason: 'could not start Broadcast: ' + String(e && e.message).slice(0, 80) };
    }
  }
  const g = await waitForGateway(timeoutMs);
  return g ? { ok: true, started: true, visible: startedVisible } : { ok: false, reason: 'Broadcast started but its gateway did not answer' };
}

module.exports = { readGateway, listTools, getCameraState, setEyeContact, ensureEyeContact, listDevices, ensureRunning };
