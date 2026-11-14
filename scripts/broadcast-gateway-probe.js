'use strict';
// Probe NVIDIA Broadcast's local MCP gateway (v2.3+).
//
// Broadcast does not expose eye contact as a callable SDK; it exposes the app's
// effects over a loopback MCP server (Streamable HTTP). This talks to it the way
// a client would: read the port from %APPDATA%\nvidia-broadcast\gateway.json
// (base64), open an MCP session, and read the live effect state. Read-only.
//
// Run: node scripts/broadcast-gateway-probe.js [--json]
const fs = require('fs');
const os = require('os');
const path = require('path');

const asJson = process.argv.includes('--json');
const log = (...a) => { if (!asJson) console.log(...a); };

function gatewayPort() {
  const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'nvidia-broadcast', 'gateway.json');
  if (!fs.existsSync(file)) return { error: 'gateway.json missing (Broadcast not running or pre-2.3)' };
  const raw = fs.readFileSync(file, 'utf8').trim();
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!decoded || !decoded.port) return { error: 'gateway.json has no port' };
    return { port: Number(decoded.port), file };
  } catch (e) {
    return { error: 'gateway.json is not base64 JSON: ' + e.message };
  }
}

// Streamable HTTP returns either application/json or text/event-stream; parse both.
function parseBody(text, contentType) {
  if (!text) return null;
  if ((contentType || '').includes('text/event-stream')) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload && payload !== '[DONE]') {
          try { return JSON.parse(payload); } catch {}
        }
      }
    }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

async function rpc(url, body, sessionId, timeoutMs = 8000) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  return { status: res.status, session: res.headers.get('mcp-session-id'), body: parseBody(text, res.headers.get('content-type')), raw: text.slice(0, 400) };
}

(async () => {
  const gw = gatewayPort();
  if (gw.error) {
    console.log(asJson ? JSON.stringify({ ok: false, ...gw }) : 'gateway: ' + gw.error);
    process.exit(1);
  }
  const url = 'http://127.0.0.1:' + gw.port + '/gateway';
  try {
    const init = await rpc(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'glance-probe', version: '0.1' } },
    });
    if (!init.body || !init.body.result) throw new Error('initialize failed: HTTP ' + init.status + ' ' + init.raw);
    const server = init.body.result.serverInfo || {};
    log('gateway:' + gw.port + '  server=' + (server.name || '?') + ' v' + (server.version || '?'));
    const session = init.session;
    await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session).catch(() => {});
    const list = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session);
    const defs = (list.body && list.body.result && list.body.result.tools) || [];
    const tools = defs.map((t) => t.name);
    log('tools: ' + tools.join(', '));
    if (process.argv.includes('--schemas')) {
      for (const d of defs) {
        if (!/set_effects|get_broadcast_state|list_devices|set_active_device/.test(d.name)) continue;
        console.log('### ' + d.name + '\n' + JSON.stringify(d.inputSchema, null, 1));
      }
    }
    let state = null;
    if (tools.includes('get_broadcast_state')) {
      const st = await rpc(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_broadcast_state', arguments: { effectType: 'camera' } } }, session);
      state = st.body && st.body.result ? st.body.result.structuredContent || st.body.result : st.body;
      log('camera state: ' + JSON.stringify(state, null, 1).slice(0, 1600));
    }
    if (asJson) console.log(JSON.stringify({ ok: true, port: gw.port, server, tools, state }, null, 1));
  } catch (e) {
    const out = { ok: false, port: gw.port, error: String(e && e.message) };
    console.log(asJson ? JSON.stringify(out) : 'gateway probe failed: ' + out.error);
    process.exit(1);
  }
})();

