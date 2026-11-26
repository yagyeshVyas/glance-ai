'use strict';
// Evaluate an expression in the running app's renderer, from a plain shell.
//
//   node scripts/cdp-eval.js "window.glance.windowShown()"
//   node scripts/cdp-eval.js --port 9333 "JSON.stringify(document.title)"
//
// The app has to be started with --remote-debugging-port; `npm start` does not
// pass arguments through, so run the binary directly:
//   node -e "process.stdout.write(require('electron'))"   # path
//   <path> . --remote-debugging-port=9333
//
// Used by the probes (self-capture, capture exclusion, browser proof) and handy on
// its own when the question is "what does the renderer think right now".

const http = require('http');

function list(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 5000 }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('devtools port ' + port + ' timed out')));
    req.on('error', reject);
  });
}

function evaluate(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('evaluation timed out')); }, timeoutMs);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (msg.result && msg.result.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.text + ': ' +
          (msg.result.exceptionDetails.exception && msg.result.exceptionDetails.exception.description || '')));
      } else {
        resolve(msg.result ? msg.result.result : undefined);
      }
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('websocket: ' + (e.message || 'error'))); });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const pi = argv.indexOf('--port');
  const port = Number(pi >= 0 ? argv[pi + 1] : (process.env.CDP_PORT || 9333));
  const expr = argv.filter((a, i) => a !== '--port' && !(pi >= 0 && i === pi + 1))[0];
  if (!expr) { console.error('usage: node scripts/cdp-eval.js [--port N] "<expression>"'); process.exit(2); }

  const targets = await list(port);
  const page = targets.find((t) => t.type === 'page' && /index\.html|renderer/i.test(t.url || '')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target on port ' + port + ' — is the app running with --remote-debugging-port?');

  const result = await evaluate(page.webSocketDebuggerUrl, expr);
  console.log(JSON.stringify(result && 'value' in result ? result.value : result, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { list, evaluate };
