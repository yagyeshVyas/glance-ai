// Integration harness for src/main.js: boots the real `whenReady` path against a
// stubbed Electron, then drives the real IPC handlers. No GUI, no network.
//
// Run: npm run test:main
//
// It exists because the unit tests only cover shared.js: the credential and stream
// paths live in main.js, and a `return` missing from requireKey shipped for exactly
// that reason. Every check below asserts an observable (the Authorization header that
// was actually sent, the events the renderer actually received).
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed++;
  console.log('ok  ', name);
};
const okAsync = async (name, fn) => {
  await fn();
  passed++;
  console.log('ok  ', name);
};

const userData = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'glance-main-'));

// ---------- stubbed Electron ----------
const handlers = new Map();
let sent = []; // what main sent to the renderer
const protection = []; // setContentProtection calls: proves the stealth switch reaches the window
const fakeEvent = {
  senderFrame: { url: 'file:///app/src/renderer/index.html' },
  sender: { isDestroyed: () => false, send: (ch, payload) => sent.push({ ch, payload }) },
};
const untrustedEvent = {
  senderFrame: { url: 'https://evil.test/' },
  sender: { isDestroyed: () => false, send: () => {} },
};

function makeWindow() {
  const w = {
    webContents: { send: (ch, payload) => sent.push({ ch, payload }), isLoading: () => false, once: () => {} },
    isDestroyed: () => false,
    isVisible: () => true,
    loadFile: () => {},
    setAlwaysOnTop: () => {},
    setVisibleOnAllWorkspaces: () => {},
    setContentProtection: (on) => protection.push(Boolean(on)),
    on: () => {},
    once: () => {},
    getBounds: () => ({ x: 100, y: 100, width: 760, height: 600 }),
    getPosition: () => [100, 100],
    setPosition: () => {},
    setOpacity: () => {},
    hide: () => {},
    showInactive: () => {},
    focus: () => {},
    setIgnoreMouseEvents: () => {},
    getNativeWindowHandle: () => Buffer.from([0,0,0x28,0x0b]),
  };
  return w;
}

const app = {
  requestSingleInstanceLock: () => true,
  getPath: () => userData,
  whenReady: () => Promise.resolve(),
  on: () => {},
  quit: () => {},
  commandLine: { hasSwitch: () => false, appendSwitch: () => {} },
};
const screenStub = {
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getAllDisplays: () => [{ id: 1, label: 'D1', size: { width: 1920, height: 1080 } }],
  getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
};
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
};
const electronStub = {
  app,
  BrowserWindow: function BrowserWindow() {
    return makeWindow();
  },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  desktopCapturer: { getSources: async () => [] },
  screen: screenStub,
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: () => {},
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
    },
  },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage,
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electronStub;
  return origLoad.call(this, request, ...rest);
};

const mainExports = require(path.join(__dirname, '..', 'src', 'main.js')); // boots the app; also exports the wipe helper
const { spawnSync } = require('child_process');

// ---------- helpers ----------
const call = (channel, event, payload) => handlers.get(channel)(event, payload);
const authOf = (opts) => (opts && opts.headers ? opts.headers.Authorization : undefined);

function sse(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}
const delta = (text) => ({ choices: [{ delta: { content: text } }] });

(async () => {
  await new Promise((r) => setImmediate(r)); // let whenReady().then(...) register handlers

  await okAsync('the app registers its IPC handlers', async () => {
    for (const ch of ['ask', 'transcribe', 'speak', 'models:list', 'config:get', 'config:set',
      'capture:one', 'update:check', 'update:install']) {
      assert.ok(handlers.has(ch), `missing handler ${ch}`);
    }
  });

  await okAsync('update:check refuses a dev checkout instead of throwing', async () => {
    const r = await handlers.get('update:check')(fakeEvent);
    assert.strictEqual(r.ok, false);
    // app.isPackaged is false under the stub, so this is the expected path
    assert.match(r.error, /installed build|unavailable/);
  });

  await okAsync('update:install is safe when no updater was set up', async () => {
    const r = await handlers.get('update:install')(fakeEvent);
    assert.strictEqual(typeof r.ok, 'boolean');
  });

  ok('an untrusted sender is refused', () => {
    const r = handlers.get('config:get')(untrustedEvent);
    assert.strictEqual(r.error, 'unauthorized: IPC sender is not the app window');
  });

  // The OS-level effect is measured separately (npm run audit against a running app);
  // this asserts the switch is wired to the window at all.
  ok('the stealth switch reaches the window (setContentProtection)', () => {
    call('config:set', fakeEvent, { stealth: false });
    assert.strictEqual(protection[protection.length - 1], false, 'stealth off never reached the window');
    call('config:set', fakeEvent, { stealth: true });
    assert.strictEqual(protection[protection.length - 1], true, 'stealth on never reached the window');
  });

  // ---------- credentials reach the provider ----------
  call('config:set', fakeEvent, {
    apiKey: 'test-key-123',
    baseUrl: 'https://api.test/v1',
    transcribeBaseUrl: '',
    ttsBaseUrl: '',
  });

  let calls = [];
  const jsonOk = (body) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: authOf(opts) });
    return jsonOk({ text: 'hello', data: [{ id: 'a-model' }] });
  };

  await okAsync('transcribe sends the real key, not "Bearer undefined"', async () => {
    const r = await call('transcribe', fakeEvent, { data: new Uint8Array([1, 2, 3]), mime: 'audio/webm' });
    assert.strictEqual(r.error, undefined, r.error);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.test/v1/audio/transcriptions');
    assert.strictEqual(calls[0].auth, 'Bearer test-key-123');
    assert.strictEqual(r.text, 'hello');
  });

  await okAsync('speak sends the real key, not "Bearer undefined"', async () => {
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: authOf(opts) });
      return new Response(Buffer.from('mp3-bytes'), { status: 200 });
    };
    const r = await call('speak', fakeEvent, { text: 'read this' });
    assert.strictEqual(r.error, undefined, r.error);
    assert.strictEqual(calls[0].url, 'https://api.test/v1/audio/speech');
    assert.strictEqual(calls[0].auth, 'Bearer test-key-123');
    assert.strictEqual(r.audio, Buffer.from('mp3-bytes').toString('base64'));
  });

  // ---------- model discovery: no cross-provider key ----------
  call('config:set', fakeEvent, { transcribeBaseUrl: 'https://audio.test/v1', transcribeApiKey: '' });

  await okAsync('models:list refuses to lend the chat key to a different audio provider', async () => {
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: authOf(opts) });
      return jsonOk({ data: [{ id: 'x' }] });
    };
    const r = await call('models:list', fakeEvent, {
      baseUrl: 'https://audio.test/v1',
      apiKey: '',
      purpose: 'transcribe',
    });
    assert.ok(r.error, 'expected an error, got models');
    assert.strictEqual(calls.length, 0, 'a request left the app with no key for that host');
  });

  await okAsync('models:list still uses the stored key on the configured chat origin', async () => {
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: authOf(opts) });
      return jsonOk({ data: [{ id: 'a-model' }] });
    };
    const r = await call('models:list', fakeEvent, { baseUrl: 'https://api.test/v1', apiKey: '', purpose: 'chat' });
    assert.deepStrictEqual(r.models, ['a-model']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].auth, 'Bearer test-key-123');
  });

  // ---------- TTS model discovery obeys the same cross-provider rule ----------
  call('config:set', fakeEvent, { ttsBaseUrl: 'https://tts.test/v1', ttsApiKey: '' });

  await okAsync('models:list refuses to lend the chat key to a separate TTS provider', async () => {
    calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: authOf(opts) });
      return jsonOk({ data: [{ id: 'x' }] });
    };
    const r = await call('models:list', fakeEvent, {
      baseUrl: 'https://tts.test/v1',
      apiKey: '',
      purpose: 'tts',
    });
    assert.ok(r.error, 'expected an error, got models');
    assert.strictEqual(calls.length, 0, 'a request left the app with no key for that host');
  });

  await okAsync('models:list supports purpose=tts on the chat origin with the chat key', async () => {
    calls = [];
    call('config:set', fakeEvent, { ttsBaseUrl: '', ttsApiKey: '' });
    global.fetch = async (url, opts) => {
      calls.push({ url: String(url), auth: authOf(opts) });
      return jsonOk({ data: [{ id: 'tts-1' }] });
    };
    const r = await call('models:list', fakeEvent, { baseUrl: 'https://api.test/v1', apiKey: '', purpose: 'tts' });
    assert.deepStrictEqual(r.models, ['tts-1']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].auth, 'Bearer test-key-123');
  });

  // ---------- stream retry must not duplicate the answer ----------
  call('config:set', fakeEvent, { transcribeBaseUrl: '' });

  await okAsync('a mid-stream retry resets the pane instead of appending twice', async () => {
    let attempt = 0;
    global.fetch = async () => {
      attempt++;
      if (attempt === 1) {
        const enc = new TextEncoder();
        let step = 0;
        const broken = new ReadableStream({
          pull(controller) {
            if (step === 0) {
              controller.enqueue(enc.encode(sse(delta('PARTIAL'))));
              step++;
              return;
            }
            controller.error(new Error('socket hang up'));
          },
        });
        return new Response(broken, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      // no trailing newline on the last data line: the tail of a stream is still a token
      const body = sse(delta('HI')) + 'data: ' + JSON.stringify(delta(' THERE'));
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };

    sent = [];
    await call('ask', fakeEvent, { id: 7, messages: [{ role: 'user', content: 'hi' }], withScreen: false });
    const events = sent.map((s) => s.ch);
    assert.deepStrictEqual(events, ['chunk', 'reset', 'chunk', 'chunk', 'done']);
    assert.strictEqual(sent[0].payload.text, 'PARTIAL');
    assert.strictEqual(sent[2].payload.text, 'HI');
    assert.strictEqual(sent[3].payload.text, ' THERE'); // unterminated tail was not dropped
    assert.strictEqual(attempt, 2);
  });

  await okAsync('a 4xx is not retried and reaches the renderer as an error', async () => {
    let hits = 0;
    global.fetch = async () => {
      hits++;
      return new Response('bad key', { status: 401 });
    };
    sent = [];
    await call('ask', fakeEvent, { id: 8, messages: [{ role: 'user', content: 'hi' }], withScreen: false });
    assert.strictEqual(hits, 1);
    const err = sent.find((s) => s.ch === 'error');
    assert.ok(err, 'no error event');
    assert.strictEqual(err.payload.id, 8);
    assert.match(err.payload.message, /API 401/);
  });

  await okAsync('pre-captured shots are attached and memory is injected', async () => {
    let body = null;
    global.fetch = async (_url, opts) => {
      body = JSON.parse(opts.body);
      return new Response(sse(delta('ok')), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    sent = [];
    const b64 = Buffer.from('fake-jpeg-bytes').toString('base64');
    // desktopCapturer.getSources returns [] in the stub, so a fresh grab would
    // throw "No screen source available" — passing proves the pile was used.
    await call('ask', fakeEvent, {
      id: 9,
      messages: [{ role: 'user', content: 'what is on screen?' }],
      withScreen: true,
      images: [{ b64, tokens: 765 }, { b64, tokens: 765 }, { b64, tokens: 765 }],
      memory: [{ kind: 'chat', text: 'the user prefers tabs over spaces' }],
    });
    const last = body.messages[body.messages.length - 1];
    assert.ok(Array.isArray(last.content), 'the newest turn should carry image parts');
    const imgs = last.content.filter((p) => p.type === 'image_url');
    assert.strictEqual(imgs.length, 3, 'all three captured shots were not attached');
    assert.ok(imgs[0].image_url.url.endsWith(b64), 'the supplied shot bytes were not used');
    assert.match(body.messages[0].content, /prefers tabs over spaces/, 'memory was not injected into the system prompt');
  });

  // ---------- state round-trip ----------
  await okAsync('state:set encrypts history at rest', async () => {
    await call('state:set', fakeEvent, { history: [{ role: 'user', content: 'secret turn' }], transcript: 'hello' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'state.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(onDisk), ['enc']);
    const r = await call('state:get', fakeEvent);
    assert.strictEqual(r.history[0].content, 'secret turn');
  });

  // ---------- wipe helper: the marker is the authority ----------
  const runHelper = (dir, marker) => {
    const dead = spawnSync(process.execPath, ['-e', '0']); // a pid that has exited
    const cmd = mainExports.wipeHelperCommand(dir, marker, dead.pid);
    assert.ok(cmd.exe, 'no PowerShell found to run the wipe helper');
    return spawnSync(cmd.exe, cmd.args, { timeout: 60000, windowsHide: true });
  };

  await okAsync('the wipe helper removes the profile while the marker exists', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wshx-wipe-'));
    const marker = dir + '.marker';
    fs.writeFileSync(path.join(dir, 'config.json'), '{"apiKeyEnc":"x"}');
    fs.writeFileSync(marker, String(Date.now()));
    const r = runHelper(dir, marker);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(dir), false, 'profile survived the wipe');
    assert.strictEqual(fs.existsSync(marker), false, 'marker survived the wipe');
  });

  await okAsync('the wipe helper leaves the profile alone once the marker is gone', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wshx-wipe-'));
    const marker = dir + '.marker'; // not created: a Settings save cancelled the wipe
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, '{"apiKeyEnc":"new"}');
    const r = runHelper(dir, marker);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.existsSync(cfg), true, 'a cancelled wipe still deleted the profile');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.rmSync(userData, { recursive: true, force: true });
  console.log(`\n${passed} main-process tests passed`);
})().catch((err) => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {}
  console.error('FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
