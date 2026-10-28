const $ = (id) => document.getElementById(id);
const api = window.glance;

const el = {
  panel: $('panel'),
  status: $('status'), transcript: $('transcript'), answer: $('answer'), shot: $('shot'),
  question: $('question'), stop: $('stop'), listen: $('listen'),   source: $('source'),
  settings: $('settings'), exportMd: $('exportMd'),
  eyeBtn: $('eyeBtn'),
  eyeHud: $('eyeHud'),
  eyeDot: $('eyeDot'),
  eyeLabel: $('eyeLabel'),
  eyeCanvas: $('eyeCanvas'),
};

let transcriptText = '';
let transcriptLog = []; // [{ at: ISO, text }] — full transcript with timestamps, survives restarts
let history = []; // chat turns kept for follow-ups
let reqId = 0;
let activeReq = 0;
let answerRaw = '';
let lastQuery = null; // { text, withScreen } for the Retry button
let lastAssistantShown = ''; // last finished answer, re-shown after error clear
let appCfg = {}; // cached config snapshot (practiceMode etc.), refreshed on load and Save
let memory = []; // long-term memory: durable notes reused across chats [{ at, kind, text }]

// ---------- state persistence ----------
let saveTimer = null;
let wiped = false; // after Wipe all data, nothing may write state back to disk
function persistState() {
  if (wiped) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.setState({ history, transcript: transcriptText, transcriptLog: transcriptLog.slice(-500), memory: memory.slice(-200) });
  }, 1000);
}

// ---------- shot pile: capture screenshots first, ask afterwards ----------
const MAX_SHOTS = 5; // never send more than 5 frames per question
let shotPile = []; // [{ b64, tokens }] — user-collected frames awaiting a question
function clearShotPile() {
  shotPile = [];
  paintShotPile();
}
function paintShotPile() {
  const tray = $('shotTray');
  const thumbs = $('shotThumbs');
  thumbs.innerHTML = '';
  shotPile.forEach((s, i) => {
    const img = document.createElement('img');
    img.src = 'data:image/jpeg;base64,' + s.b64;
    img.title = 'Screenshot ' + (i + 1);
    thumbs.appendChild(img);
  });
  tray.hidden = shotPile.length === 0;
  $('shotTrayLabel').textContent = shotPile.length ? shotPile.length + ' shot(s) ready' : '';
  const snap = $('snapBtn');
  snap.textContent = shotPile.length ? 'Capture (' + shotPile.length + ')' : 'Capture';
  snap.classList.toggle('on', shotPile.length > 0);
}
async function captureShot() {
  const snap = $('snapBtn');
  snap.disabled = true;
  try {
    const r = await api.captureOne();
    if (r.error) return setStatus('Capture failed: ' + String(r.error).slice(0, 80), true);
    shotPile.push({ b64: r.b64, tokens: r.tokens });
    // hard cap: at most MAX_SHOTS frames per question
    if (shotPile.length > MAX_SHOTS) shotPile.shift();
    paintShotPile();
    setStatus(
      shotPile.length >= MAX_SHOTS
        ? MAX_SHOTS + ' shots is the max — ask your question (Enter) or Clear shots'
        : 'Captured ' + shotPile.length + ' screenshot(s) — type your question and press Enter',
    );
  } finally {
    snap.disabled = false;
  }
}

// append a durable memory note and persist it (bounded, newest-last)
function addMemory(kind, text) {
  text = String(text || '').trim();
  if (!text) return;
  memory.push({ at: new Date().toISOString(), kind, text });
  if (memory.length > 200) memory = memory.slice(-200);
  persistState();
}

// short local stamp for transcript lines: "Oct 23, 2:03 PM"
function stampAt(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function paintTranscript() {
  el.transcript.classList.remove('muted');
  el.transcript.textContent = transcriptLog.map((e) => `[${stampAt(e.at)}] ${e.text}`).join('\n');
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

(async function restoreState() {
  try {
    const s = await api.getState();
    if (Array.isArray(s.history) && s.history.length) {
      history = s.history;
      const lastA = [...history].reverse().find((m) => m.role === 'assistant');
      if (lastA) {
        lastAssistantShown = lastA.content;
        answerRaw = lastA.content;
        showAnswer();
      }
    }
    if (s.transcriptLog?.length) {
      transcriptLog = s.transcriptLog;
      transcriptText = s.transcript || transcriptLog.map((e) => e.text).join(' ');
      paintTranscript();
    } else if (s.transcript) {
      transcriptText = s.transcript;
      transcriptLog = [{ at: new Date().toISOString(), text: s.transcript }];
      paintTranscript();
    }
    if (Array.isArray(s.memory)) memory = s.memory;
  } catch {}
})();

// ---------- helpers ----------
function setStatus(msg, isErr = false) {
  el.status.textContent = msg;
  el.status.className = 'status' + (isErr ? ' err' : '');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// tiny, escape-first markdown: fenced code, inline code, bold
function renderMd(src) {
  const parts = src.split(/```/);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return `<pre><code>${escapeHtml(p.replace(/^[\w+-]*\n/, ''))}</code></pre>`;
      return escapeHtml(p)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    })
    .join('');
}

function showAnswer() {
  el.answer.innerHTML = renderMd(answerRaw);
  el.answer.scrollTop = el.answer.scrollHeight;
}

// streaming renders coalesce to one paint per frame, keeping the scroll pinned to the bottom
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const box = el.answer;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = renderMd(answerRaw);
    if (atBottom) box.scrollTop = box.scrollHeight;
  });
}

function showSkeleton() {
  el.answer.innerHTML =
    '<div class="skeleton-line"></div><div class="skeleton-line"></div>' +
    '<div class="skeleton-line short"></div>';
}

// ---------- auto-screen: fresh capture with every question ----------
let autoScreen = true; // default ON — every question sees the current screen
(function initAutoScreen() {
  const btn = document.getElementById('autoScreenBtn');
  const paint = () => {
    btn.classList.toggle('on', autoScreen);
    btn.textContent = 'Screen: ' + (autoScreen ? 'auto' : 'manual');
  };
  btn.addEventListener('click', () => {
    autoScreen = !autoScreen;
    paint();
  });
  paint();
})();

// ---------- OCR: text is extracted locally and attached to captures ----------
let ocrOn = true; // default ON — Windows OCR is free, local and offline
function paintOcr() {
  const b = document.getElementById('ocrToggle');
  if (b) {
    b.classList.toggle('on', ocrOn);
    b.textContent = 'OCR: ' + (ocrOn ? 'on' : 'off');
  }
}
api.getOcr = () => ocrOn;
api.setOcr = (v) => { ocrOn = !!v; paintOcr(); };
paintOcr();
document.getElementById('ocrToggle').addEventListener('click', () => {
  ocrOn = !ocrOn;
  paintOcr();
  setStatus(ocrOn ? 'OCR on — text is read locally from every capture' : 'OCR off — vision model reads pixels only');
  persistState();
});
let practiceLive = false; // true while a practice-mode session records
let pendingDebrief = false; // finish() turns the matching answer into a saved debrief
let debriefReqId = 0; // request the debrief belongs to — a bare boolean leaked into later answers
let lastDebrief = ''; // the debrief text as it was saved, so Export cannot drift

function send(text, withScreen, shots, noScreen, images) {
  text = text.trim();
  if (!text) return;
  if (practiceLive) return setStatus('Practice session recording — press Stop for the debrief', true);
  // Captured shots take priority: if the user piled up screenshots, every
  // question answers from them (even a plain Enter) unless it opted out.
  const pile = noScreen ? null : (Array.isArray(images) ? images : (shotPile.length ? shotPile.slice() : null));
  const screen = noScreen ? false : (withScreen || autoScreen || Boolean(pile));
  // inject live eye-tracking context so the model knows gaze + attention
  if (window.glanceEye && window.glanceEye.on) {
    const gaze = window.glanceEye.gazeDescriptor();
    if (gaze && !gaze.startsWith('No face')) {
      text += '\n\n[Eye tracking context: ' + gaze + ']';
    }
  }
  lastQuery = { text, withScreen: screen, shots, images: pile };
  activeReq = ++reqId;
  answerRaw = '';
  showSkeleton();
  el.shot.hidden = true;
  el.stop.hidden = false;
  setStatus(pile && pile.length ? `Using ${pile.length} captured shot(s)…` : screen ? 'Capturing screen…' : 'Thinking…');
  history.push({ role: 'user', content: text, at: new Date().toISOString() });
  // the screenshot is attached only to the newest turn; keep history text-only
  api.ask({
    id: activeReq,
    messages: history.slice(-12).map(({ at, ...m }) => m),
    withScreen: screen,
    shots,
    memory,
    images: pile || undefined,
  });
  // the pile was consumed by this request
  if (pile && pile.length && !images) clearShotPile();
}

function finish(commit = true, id = activeReq) {
  el.stop.hidden = true;
  if (commit && answerRaw) {
    history.push({ role: 'assistant', content: answerRaw, at: new Date().toISOString() });
    lastAssistantShown = answerRaw;
    // auto-memory: keep a compact Q→A note of screen analyses so a later chat
    // (even after "New chat") can answer from what was already on screen,
    // without replaying raw turns or re-capturing frames
    if (lastQuery && lastQuery.withScreen) {
      const n = (lastQuery.images && lastQuery.images.length) || lastQuery.shots || 1;
      addMemory('screen', '[' + n + ' shot(s)] Q: ' + lastQuery.text.slice(0, 300) + '\nA: ' + answerRaw.slice(0, 900));
    }
  }
  setStatus('');
  persistState();
  // only the request that actually produced the debrief may save it: if the debrief
  // failed, a flag that stayed true used to file the NEXT ordinary answer as a session
  if (pendingDebrief && id === debriefReqId) {
    pendingDebrief = false;
    savePracticeSession();
  }
}

api.onShot(({ id, b64 }) => {
  if (id !== activeReq) return;
  el.shot.src = 'data:image/jpeg;base64,' + b64;
  el.shot.hidden = false;
  setStatus('Thinking…');
});
api.onReasoning(({ id }) => {
  if (id !== activeReq) return;
  setStatus('Thinking…'); // reasoning tokens — keep skeleton up, don't touch answer
});
// main retries a broken stream from its first token: drop the partial attempt, or the
// pane shows the partial reply followed by the full one
api.onReset(({ id }) => {
  if (id !== activeReq) return;
  answerRaw = '';
  showSkeleton();
});
api.onChunk(({ id, text }) => {
  if (id !== activeReq) return;
  answerRaw += text;
  scheduleRender();
});
api.onDone(({ id }) => id === activeReq && finish(true, id));
api.onNotice(({ level, message }) => {
  setStatus(message, level === 'error');
  // an update that finished downloading is actionable: clicking the status bar
  // restarts into it instead of making the user hunt for Settings
  const ready = /ready — restart to apply/.test(message || '');
  el.status.style.cursor = ready ? 'pointer' : '';
  el.status.onclick = ready ? () => api.updateInstall() : null;
});
api.onError(({ id, message }) => {
  if (id !== activeReq) return;
  if (id === debriefReqId) pendingDebrief = false; // the debrief will never arrive
  if (history.length && history[history.length - 1].role === 'user') history.pop(); // drop the failed user turn
  el.answer.innerHTML =
    `<span class="err">${escapeHtml(message)}</span>` +
    (lastQuery ? ' <button id="retryBtn" class="tiny">Retry</button>' : '');
  const retryBtn = document.getElementById('retryBtn');
  // retry with the same frame count — a Long task ×3 stays ×3
  if (retryBtn) retryBtn.addEventListener('click', () => lastQuery && send(lastQuery.text, lastQuery.withScreen, lastQuery.shots, !lastQuery.withScreen, lastQuery.images));
  el.stop.hidden = true;
  setStatus('Error', true);
  persistState();
});

$('askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send(el.question.value, false);
  el.question.value = '';
});
el.question.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault();
    send(el.question.value || 'What is on my screen? Answer whatever question or task it shows.', true);
    el.question.value = '';
  }
});
// in-window Ctrl+Shift+S captures a screenshot into the pile
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    captureShot();
  }
});
// a stopped stream is not a completed turn — don't commit a half answer to history
el.stop.addEventListener('click', () => {
  api.cancel();
  finish(false);
});

function askScreen() {
  const q = el.question.value || 'What is on my screen? Answer whatever question or task it shows.';
  // if the user piled up screenshots, answer from those; otherwise grab up to
  // MAX_SHOTS frames in sequence so scrolling content is all captured
  if (shotPile.length) send(q, true);
  else send(q, true, MAX_SHOTS);
  el.question.value = '';
}

// Start a fresh chat. The current conversation is distilled into durable memory
// first, so a later chat still answers from what was learned here.
function newChat() {
  const pairs = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const a = history[i + 1] && history[i + 1].role === 'assistant' ? history[i + 1].content : '';
    pairs.push('Q: ' + m.content.slice(0, 200) + (a ? '\nA: ' + a.slice(0, 400) : ''));
  }
  if (pairs.length) addMemory('chat', pairs.slice(-6).join('\n---\n'));
  history = [];
  answerRaw = '';
  lastAssistantShown = '';
  lastQuery = null;
  pendingDebrief = false;
  debriefReqId = 0;
  el.answer.innerHTML = '<span class="muted">New chat — previous chat saved to memory.</span>';
  el.shot.hidden = true;
  el.exportMd.hidden = true;
  clearShotPile();
  persistState();
  setStatus('New chat started — previous chat saved to memory');
}
function answerFromTranscript() {
  if (!transcriptText.trim()) return setStatus('No transcript yet', true);
  send(
    'Here is the live transcript of the conversation so far. Tell me what I should say or do next, ' +
      'answering any question that was just asked.\n\nTranscript:\n' + transcriptText.slice(-6000),
    false,
  );
}
function recapTranscript() {
  if (!transcriptText.trim()) return setStatus('No transcript yet', true);
  send(
    'Summarize this conversation transcript into clean, shareable meeting notes: ' +
      'key decisions, action items with owners, open questions, and a 2-line recap at the top.\n\nTranscript:\n' +
      transcriptText.slice(-10000),
    false,
  );
}
$('askScreen').addEventListener('click', askScreen);
$('snapBtn').addEventListener('click', captureShot);
$('clearShots').addEventListener('click', () => { clearShotPile(); setStatus('Shot pile cleared'); });
$('newChat').addEventListener('click', newChat);
$('answerTranscript').addEventListener('click', answerFromTranscript);
$('recap').addEventListener('click', recapTranscript);

// ---------- audio capture + transcription ----------
// CHUNK_MS lives in the Copilot block (fast mode adjusts it)
let stream = null;
let listening = false;

async function openStream(kind) {
  if (kind === 'system') {
    // main process answers with loopback audio; we only keep the audio track
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => t.stop());
    if (!s.getAudioTracks().length) throw new Error('No system audio track available');
    return new MediaStream(s.getAudioTracks());
  }
  return navigator.mediaDevices.getUserMedia({ audio: true });
}

function recordOnce(ms) {
  return new Promise((resolve) => {
    const rec = new MediaRecorder(stream);
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType }));
    rec.start();
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), ms);
  });
}

// One AudioContext for the window's lifetime: creating and closing one per 4–7 s
// chunk churns a capped resource, and a slow close throws on the next chunk.
let silentCtx = null;
function audioCtx() {
  if (!silentCtx || silentCtx.state === 'closed') {
    silentCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return silentCtx;
}

// local silence check: skip API call when the chunk is essentially inaudible
function isSilent(arrayBuffer) {
  return new Promise((resolve) => {
    const ctx = audioCtx();
    ctx.decodeAudioData(
      arrayBuffer.slice(0),
      (buf) => {
        const data = buf.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        resolve(Math.sqrt(sum / data.length) < 0.005); // RMS threshold
      },
      () => {
        resolve(false); // can't decode — let the API decide
      },
    );
  });
}

// FIFO transcription queue: chunks append in the order they were spoken, never in
// network-completion order (which scrambled the Copilot prompt under latency jitter)
const transcribeQueue = [];
let transcribeWorker = null;
const MAX_QUEUE = 8;

async function drainQueue() {
  while (transcribeQueue.length) {
    const { buf, mime } = transcribeQueue.shift();
    try {
      const r = await api.transcribe(buf, mime);
      if (r.error) {
        setStatus(r.error.slice(0, 80), true);
        continue;
      }
      const text = (r.text || '').trim();
      if (!text) continue;
      transcriptLog.push({ at: new Date().toISOString(), text });
      transcriptText += (transcriptText ? ' ' : '') + text;
      paintTranscript();
      onTranscriptUpdated();
      persistState();
    } catch (err) {
      setStatus('Transcribe failed: ' + err.message.slice(0, 60), true);
    }
  }
  if (listening) setStatus('Listening…');
  transcribeWorker = null;
}

function enqueueChunk(buf, mime) {
  if (transcribeQueue.length >= MAX_QUEUE) {
    transcribeQueue.shift();
    setStatus('Audio backlog — dropping oldest chunk', true);
  }
  transcribeQueue.push({ buf, mime });
  if (!transcribeWorker) transcribeWorker = drainQueue();
}

async function listenLoop() {
  while (listening) {
    const blob = await recordOnce(CHUNK_MS);
    if (!listening) break; // Stop arrived while this chunk was recording — do not enqueue it
    if (blob.size < 2000) continue; // near-silence / empty
    const buf = await blob.arrayBuffer();
    if (await isSilent(buf)) continue; // save an API call on silent chunks
    enqueueChunk(buf, blob.type);
  }
}

async function toggleListen() {
  if (listening) {
    listening = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    el.listen.classList.remove('on');
    el.listen.textContent = 'Listen';
    el.listen.disabled = false;
    setStatus('');
    if (practiceLive) runPracticeDebrief();
    return;
  }
  el.listen.disabled = true;
  try {
    stream = await openStream(el.source.value);
  } catch (err) {
    el.listen.disabled = false;
    return setStatus('Audio: ' + err.message, true);
  }
  listening = true;
  el.listen.classList.remove('on');
  el.listen.classList.add('on');
  el.listen.textContent = 'Stop';
  el.listen.disabled = false;
  if (appCfg.practiceMode) {
    // practice session: record and transcribe, but no live answers
    practiceLive = true;
    el.answer.innerHTML = '<span class="muted">Practice session recording — answers stay hidden. Press Stop for your scored debrief.</span>';
    setStatus('Practice recording…');
  } else {
    setStatus('Listening…');
  }
  listenLoop().catch((err) => {
    setStatus('Listen loop error: ' + err.message, true);
    toggleListen();
  });
}
el.listen.addEventListener('click', toggleListen);

// ---------- hotkey triggers from main ----------
api.onTrigger((what) => {
  if (what === 'ask-screen') askScreen();
  else if (what === 'toggle-listen') toggleListen();
  else if (what === 'answer-transcript') answerFromTranscript();
});
api.onClickThrough((on) => document.body.classList.toggle('click-through', on));

// ---------- settings ----------
const fields = ['baseUrl', 'chatModel', 'transcribeModel', 'systemPrompt',
  'transcribeBaseUrl', 'ttsBaseUrl', 'ttsVoice', 'ttsModel',
  'targetRole', 'resume', 'answerLang', 'contextTokens'];
// secrets are never read back from main; they submit blank and main keeps the stored value
const keyFields = ['apiKey', 'transcribeApiKey', 'ttsApiKey'];
const hasFlag = { apiKey: 'hasKey', transcribeApiKey: 'hasTranscribeKey', ttsApiKey: 'hasTtsKey' };
const boolFields = ['stealth', 'stealthProcess', 'smartMode', 'practiceMode', 'stealthDeep', 'stealthMaster', 'ocr'];
// Master-stealth sub-toggles it force-on when enabled. Saved here at the moment
// the user switches master ON so "un-check master" can restore them.
const MASTER_SUB_TOGGLES = ['stealth', 'stealthProcess', 'stealthDeep'];
let masterSnapshot = null;
function paintKeyPlaceholders(c) {
  for (const f of keyFields) {
    $('s_' + f).placeholder = c[hasFlag[f]] ? '•••••• (saved — leave blank to keep)' : '';
  }
}
// Full privacy = strongest of every privacy control. The eye tracker is
// already offline-by-default (vendored MediaPipe), so master only has to flip
// the capture/process/cloak boxes. Not full invisibility — see STEALTH.md.
function applyMasterStealth(enabled) {
  if (enabled) {
    masterSnapshot = {};
    for (const f of MASTER_SUB_TOGGLES) masterSnapshot[f] = $('s_' + f).checked;
    for (const f of MASTER_SUB_TOGGLES) $('s_' + f).checked = true;
  } else if (masterSnapshot) {
    for (const f of MASTER_SUB_TOGGLES) $('s_' + f).checked = Boolean(masterSnapshot[f]);
  }
}
async function openSettings() {
  const c = await api.getConfig();
  fields.forEach((f) => ($('s_' + f).value = c[f] || ''));
  for (const f of keyFields) $('s_' + f).value = '';
  paintKeyPlaceholders(c);
  boolFields.forEach((f) => ($('s_' + f).checked = Boolean(c[f])));
  $('s_panelOpacity').value = c.panelOpacity ?? 0.78;
  $('opacityVal').textContent = Math.round((c.panelOpacity ?? 0.78) * 100) + '%';
  $('s_msg').textContent = '';
  el.settings.hidden = false;
  el.settings.scrollTop = 0; // reopening must land on the top fields, not wherever it was last scrolled
  refreshModels(); // async — fills the dropdowns once the provider answers
}

// fill model dropdowns from the provider's /models endpoint (works with a typed-but-unsaved key too)
let modelsSeq = 0;
async function refreshModels() {
  const base = $('s_baseUrl').value.trim();
  const key = $('s_apiKey').value.trim();
  const seq = ++modelsSeq; // a newer keystroke makes any stale response irrelevant
  for (const purpose of ['chat', 'transcribe', 'tts']) {
    const id = purpose === 'chat' ? 'chatModel' : purpose === 'transcribe' ? 'transcribeModel' : 'ttsModel';
    const input = $('s_' + id);
    const list = $(purpose === 'chat' ? 'chatModels' : purpose === 'transcribe' ? 'transcribeModels' : 'ttsModels');
    const url = purpose === 'chat' ? base : purpose === 'transcribe'
      ? $('s_transcribeBaseUrl').value.trim() || base
      : $('s_ttsBaseUrl').value.trim() || base;
    const keyField = purpose === 'chat' ? 'apiKey' : purpose === 'transcribe' ? 'transcribeApiKey' : 'ttsApiKey';
    // Never borrow the chat key to enumerate a different audio provider's models —
    // that is the same cross-provider leak main refuses on the request path. With no
    // transcription/TTS key there is nothing legitimate to send to that host.
    if (purpose !== 'chat' && !$('s_' + keyField).value.trim()) {
      let foreign = false;
      try {
        foreign = new URL(url).origin !== new URL(base).origin;
      } catch {}
      if (foreign) {
        input.placeholder = 'add the ' + (purpose === 'transcribe' ? 'transcription' : 'TTS') + ' key to list its models';
        continue;
      }
    }
    const r = await api.listModels({
      baseUrl: url,
      apiKey: purpose === 'chat' ? key : $('s_' + keyField).value.trim() || key,
      purpose,
    });
    if (seq !== modelsSeq) return; // user typed again — discard this result
    if (r.error) {
      input.placeholder = 'fetch failed — type model manually';
      continue;
    }
    list.innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    input.placeholder = r.models.length ? `${r.models.length} models — pick or type` : 'no models listed — type manually';
  }
}

// debounced: don't hammer the provider on every change event
let modelsDebounce = null;
const refreshModelsDebounced = () => {
  clearTimeout(modelsDebounce);
  modelsDebounce = setTimeout(refreshModels, 600);
};
for (const id of ['s_baseUrl', 's_apiKey', 's_transcribeBaseUrl', 's_transcribeApiKey', 's_ttsBaseUrl', 's_ttsApiKey']) {
  $(id).addEventListener('change', refreshModelsDebounced);
}
$('gear').addEventListener('click', openSettings);
$('s_close').addEventListener('click', () => (el.settings.hidden = true));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.settings.hidden) el.settings.hidden = true;
});
$('s_update').addEventListener('click', async () => {
  const msg = $('s_updateMsg');
  const btn = $('s_update');
  btn.disabled = true;
  msg.textContent = 'Checking…';
  const r = await api.updateCheck();
  btn.disabled = false;
  if (!r.ok) {
    msg.textContent = r.error === 'only in an installed build'
      ? 'Only works in an installed build, not a dev checkout'
      : 'Check failed: ' + r.error;
    return;
  }
  // download runs in the background; 'notice' events drive the status
  msg.textContent = 'Check requested — progress appears in the status bar';
});
$('s_wipe').addEventListener('click', async () => {
  if (!confirm('Delete saved API key, conversation history, transcript and window position? This cannot be undone.')) return;
  wiped = true; // block any pending/late persist from resurrecting the files
  clearTimeout(saveTimer);
  await api.wipeAll();
  history = [];
  answerRaw = '';
  transcriptText = '';
  transcriptLog = [];
  lastQuery = null;
  lastDebrief = '';
  pendingDebrief = false;
  debriefReqId = 0;
  el.answer.textContent = '';
  el.transcript.textContent = 'Press Listen to start capturing audio.';
  el.transcript.classList.add('muted');
  el.shot.hidden = true;
  el.exportMd.hidden = true;
  setStatus('All data wiped', false);
  $('s_msg').textContent = 'Wiped. No settings remain on disk.';
});
$('s_panelOpacity').addEventListener('input', () => {
  $('opacityVal').textContent = Math.round($('s_panelOpacity').value * 100) + '%';
  applyOpacity($('s_panelOpacity').value);
});
$('s_stealthMaster').addEventListener('change', (e) => {
  applyMasterStealth(e.target.checked);
});
$('s_save').addEventListener('click', async () => {
  const next = { panelOpacity: parseFloat($('s_panelOpacity').value) };
  keyFields.forEach((f) => (next[f] = $('s_' + f).value.trim()));
  fields.forEach((f) => (next[f] = $('s_' + f).value.trim()));
  boolFields.forEach((f) => (next[f] = $('s_' + f).checked));
  const c = await api.setConfig(next);
  appCfg = c; // practiceMode etc. take effect immediately
  api.stealthApply?.(Boolean(c.stealthDeep));
  $('opacityVal').textContent = Math.round((c.panelOpacity ?? 0.78) * 100) + '%';
  paintKeyPlaceholders(c); // show •••••• so the saved state is visible right away
  if (c.keysNotPersisted?.length) {
    // fail-closed is right, silence is not: the key exists for this session only
    setMsg(
      'Saved for this session only — encryption is unavailable on this machine, so ' +
        c.keysNotPersisted.join(', ') +
        ' was NOT written to disk and will be gone after restart.',
      'err',
    );
  } else if (c.hasKey) {
    setMsg('Saved — key stored encrypted on this machine.');
  } else {
    setMsg('Saved — add an API key to start.');
  }
  refreshModels(); // a just-saved key unlocks the real model list
});
// settings message helper: green when the key is verified, red on failure
function setMsg(text, cls) {
  const m = $('s_msg');
  m.textContent = text;
  m.className = 'muted ' + (cls || '');
}
// real key check: hits the provider's /models with the entered (or saved) key
$('s_testKey').addEventListener('click', async () => {
  const btn = $('s_testKey');
  btn.disabled = true;
  setMsg('Testing key…');
  const r = await api.listModels({
    baseUrl: $('s_baseUrl').value.trim(),
    apiKey: $('s_apiKey').value.trim(),
    purpose: 'chat',
  });
  btn.disabled = false;
  if (r.error) {
    setMsg('✗ Key failed: ' + r.error.slice(0, 120), 'err');
  } else {
    setMsg(`✓ Key works — ${r.models.length} models available (${new Date().toLocaleTimeString()})`, 'ok');
  }
});
// delete stored keys (chat/transcribe/TTS) without touching anything else
$('s_deleteKeys').addEventListener('click', async () => {
  if (!confirm('Delete the saved API keys? You can paste a new key afterwards.')) return;
  const c = await api.setConfig({ apiKey: null, transcribeApiKey: null, ttsApiKey: null });
  appCfg = c;
  paintKeyPlaceholders(c);
  setMsg('Keys deleted.');
});
$('hide').addEventListener('click', () => api.hide());
$('close').addEventListener('click', () => api.quit());

// ---------- Copilot: auto-detect questions, auto-answer ----------
let copilotOn = false;
let copilotTimer = null;
let copilotSince = 0; // transcript length already handled — only inspect new speech
let copilotBusy = false;

// fast mode cuts detection latency: shorter audio chunks + shorter end-of-question debounce
let fastMode = false;
let CHUNK_MS = 7000;
let copilotDebounce = 2500;

// looksLikeQuestion lives in shared.js (unit-tested in scripts/test.js)

// universal Copilot prompt: the model classifies the question itself, no mode switching
const COPILOT_PROMPT =
  'You are my live interview copilot. The interviewer just finished a question. ' +
  'First silently classify it — behavioral, coding, system design, case, domain-knowledge, or general — then answer in that format:\n' +
  '- behavioral: a STAR story under 100 words, spoken style\n' +
  '- coding: read any code on my screen; approach in 2 lines, optimal code in a block, then complexity\n' +
  '- system design: requirements (2 lines), component list, key trade-offs (3 bullets)\n' +
  '- case: framework (1 line), structured walkthrough, quick math\n' +
  '- domain/general: direct spoken answer under 80 words\n' +
  'No preamble, no labels — just the answer I can say or use.\n\n' +
  'Recent transcript:\n';

function copilotTick() {
  if (!copilotOn || !listening || copilotBusy) return;
  if (appCfg.practiceMode) return; // practice mode: no live answers, ever
  if (!el.stop.hidden) return; // a request is already streaming — don't stomp it
  const fresh = transcriptText.slice(copilotSince);
  if (!fresh.trim()) return;
  if (looksLikeQuestion(fresh)) {
    copilotSince = transcriptText.length; // consume only when we act — a split question stays pending
    copilotBusy = true;
    setStatus('Copilot: question detected — answering…');
    send(COPILOT_PROMPT + transcriptText.slice(-4000), false);
    setTimeout(() => (copilotBusy = false), 15000); // cool-off
  }
}

function onTranscriptUpdated() {
  if (!copilotOn) return;
  clearTimeout(copilotTimer);
  // question is "finished" when the debounce passes with no new speech
  copilotTimer = setTimeout(copilotTick, copilotDebounce);
}

function toggleCopilot() {
  if (!copilotOn && appCfg.practiceMode) return setStatus('Copilot is disabled in practice mode — press Stop for the debrief', true);
  copilotOn = !copilotOn;
  const btn = document.getElementById('copilot');
  btn.classList.toggle('on', copilotOn);
  btn.textContent = 'Copilot: ' + (copilotOn ? 'on' : 'off');
  if (copilotOn) {
    copilotSince = transcriptText.length;
    if (!listening) toggleListen();
    setStatus('Copilot armed' + (fastMode ? ' (fast)' : ''));
  } else {
    clearTimeout(copilotTimer);
    // auto-debrief: recap the session when Copilot is turned off
    if (transcriptText.trim().length > 40) {
      setStatus('Writing session recap…');
      recapTranscript();
    }
  }
}
document.getElementById('copilot').addEventListener('click', toggleCopilot);

// ---------- eye tracking (webcam gaze + attention) ----------
(function initEye() {
  const btn = el.eyeBtn;
  let hudTimer = 0;
  // paint the button from the tracker's real state, not from the click intent —
  // startEye() is async (camera + model load) and can fail, so the text must
  // follow what actually happened.
  const syncEyeBtn = () => {
    const on = window.glanceEye.on;
    btn.classList.toggle('on', on);
    btn.textContent = 'Eye: ' + (on ? 'on' : 'off');
    if (!on) el.eyeHud.hidden = true;
  };
  window.glanceEye.setOnStatus((msg, err) => {
    setStatus(msg, err);
    syncEyeBtn();
  });
  window.glanceEye.setOnFrame((s) => {
    // update HUD at ~10 fps to avoid layout thrash
    if (!hudTimer || performance.now() - hudTimer > 100) {
      hudTimer = performance.now();
      el.eyeHud.hidden = !window.glanceEye.on;
      el.eyeDot.className = s.visible ? (s.blink ? 'blink' : 'on') : 'off';
      el.eyeLabel.textContent = s.visible
        ? 'Eye ' + Math.round(s.attention * 100) + '%'
        : 'Eye —';
      // mirror the live camera + face-mesh canvas into the HUD
      const src = window.glanceEye.canvas;
      if (src) {
        const dst = el.eyeCanvas;
        if (dst.width !== src.width) dst.width = src.width;
        if (dst.height !== src.height) dst.height = src.height;
        dst.getContext('2d').drawImage(src, 0, 0);
      } else {
        el.eyeCanvas.getContext('2d').clearRect(0, 0, el.eyeCanvas.width, el.eyeCanvas.height);
      }
    }
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setStatus(window.glanceEye.on ? 'Eye tracking stopping…' : 'Eye tracking starting…');
    try {
      await window.glanceEye.toggle();
    } finally {
      syncEyeBtn();
      btn.disabled = false;
    }
  });
  // hotkey: Ctrl+Shift+E
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      btn.click();
    }
  });
  // Screen-based morph: no camera picker and no webcam. Turn it on by default
// (stealth-safe, no egress); it captures the screen where other apps already
// show your camera, so it never competes for the camera device.
  if (window.glanceEye.defaultOn) {
    setStatus('Eye morph starting…');
    window.glanceEye.autoStart();
    setTimeout(syncEyeBtn, 2000);
    setTimeout(syncEyeBtn, 6000);
  }
})();

// ---------- practice mode: debrief after the session ends ----------
const DEBRIEF_PROMPT =
  'This is a recorded practice session (interview rehearsal). Transcript only — the user could not see answers while it ran.\n' +
  'Produce a coaching debrief as Markdown:\n' +
  '1. A table of every question you can detect in the transcript, scored 1-5 on structure, specificity, and length, with the answerer\'s answer summarized in one line.\n' +
  '2. The single weakest answer and why, in two sentences.\n' +
  '3. Three concrete rewrites of that weakest answer (spoken style, under 80 words each).\n' +
  '4. One-line verdict of overall performance.\n\n' +
  'Transcript:\n';

async function runPracticeDebrief() {
  practiceLive = false;
  if (transcriptText.trim().length < 40) {
    setStatus('Practice session too short to debrief', true);
    return;
  }
  setStatus('Writing practice debrief…');
  pendingDebrief = true;
  history = []; // a debrief is standalone — no stale interview turns in context
  send(DEBRIEF_PROMPT + transcriptText.slice(-12000), false, undefined, true); // transcript-only, no screen grab
  debriefReqId = activeReq; // send() bumped it; only this request may save the session
}

async function savePracticeSession() {
  lastDebrief = answerRaw; // capture now: the answer pane is reused by the next question
  const r = await api.practiceSave({ transcript: transcriptText, debrief: lastDebrief });
  if (r.error) return setStatus('Practice save failed: ' + r.error.slice(0, 80), true);
  el.exportMd.hidden = false; // one debrief exists — offer the review sheet
  setStatus('Debrief ready — session saved. Export it from the Answer header.');
}

el.exportMd.addEventListener('click', async () => {
  const md =
    '# Practice review — ' + new Date().toLocaleString() + '\n\n' +
    '## Debrief\n\n' + lastDebrief + '\n\n' +
    '## Transcript\n\n' + transcriptText + '\n';
  const r = await api.practiceExport({ markdown: md });
  if (r.error) return setStatus('Export failed: ' + r.error.slice(0, 80), true);
  if (!r.canceled) setStatus('Review saved: ' + r.file);
});

// ---------- fast mode ----------
(function initFast() {
  const btn = document.getElementById('fastBtn');
  const paint = () => {
    btn.classList.toggle('on', fastMode);
    btn.textContent = 'Fast: ' + (fastMode ? 'on' : 'off');
  };
  btn.addEventListener('click', () => {
    fastMode = !fastMode;
    CHUNK_MS = fastMode ? 4000 : 7000;
    copilotDebounce = fastMode ? 1200 : 2500;
    paint();
    setStatus(fastMode ? 'Fast mode: 4s chunks, 1.2s detection' : 'Normal mode: 7s chunks, 2.5s detection');
  });
  paint();
})();

// ---------- quick-action templates ----------
const TEMPLATES = {
  summarize: { prompt: 'Summarize the key points of whatever is on my screen or in our conversation. Bullet list, max 5 bullets.', screen: true },
  explain: { prompt: 'Explain what is on my screen right now: what is this, and what should I do with it?', screen: true },
  fix: { prompt: 'There is code or an error on my screen. Identify the problem and give me the corrected code. Code block, then one-line reason.', screen: true },
  longtask: { prompt: 'This is a long question or task spread across my screen — I captured multiple frames (possibly while scrolling). Read them in order and solve it fully. Code block + complexity if it is code.', screen: true, shots: 3 },
  translate: { prompt: 'Detect the language of text on my screen and translate it to English. Output only the translation.', screen: true },
  draft: { prompt: 'Based on the conversation transcript so far, draft the message or reply I should send next. Output only the draft text.', screen: false },
};
document.querySelectorAll('#templates button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = TEMPLATES[btn.dataset.tpl];
    if (!t) return;
    if (t.prompt.includes('transcript') && !transcriptText.trim()) return setStatus('No transcript yet — start Listen first', true);
    send(t.prompt + (t.prompt.includes('transcript') ? '\n\nTranscript:\n' + transcriptText.slice(-6000) : ''), t.screen, t.shots);
  });
});

// ---------- voice output ----------
$('speak').addEventListener('click', async () => {
  if (!answerRaw.trim()) return setStatus('Nothing to read yet', true);
  const btn = $('speak');
  btn.disabled = true;
  setStatus('Synthesizing voice…');
  const r = await api.speak(answerRaw);
  btn.disabled = false;
  if (r.error) return setStatus(r.error.split('\n')[0].slice(0, 90), true);
  new Audio('data:audio/mp3;base64,' + r.audio).play();
  setStatus('');
});

// ---------- panel opacity ----------
function applyOpacity(a) {
  const v = Math.min(0.98, Math.max(0.3, Number(a) || 0.78));
  document.getElementById('panel').style.setProperty('--alpha', v);
}

// ---------- display picker ----------
// Builds the display list. Called once, then on window focus: the renderer has no
// display-change event, and re-running the old IIFE stacked a second 'change'
// listener on every call.
async function refreshDisplays() {
  const sel = document.getElementById('displaySel');
  let displays = [];
  try {
    displays = await api.listDisplays();
  } catch {
    return;
  }
  const c = await api.getConfig();
  appCfg = c; // snapshot of practiceMode and friends
  applyOpacity(c.panelOpacity);
  // Apply deep stealth with a small delay to let the window fully initialize,
  // then retry once if the first attempt didn't stick (race with window creation).
  const applyDeep = () => api.stealthApply?.(Boolean(c.stealthDeep));
  applyDeep();
  setTimeout(applyDeep, 1500);
  // If master stealth was left on, re-assert the strongest sub-settings so the
  // UI and saved state stay consistent across restarts.
  if (c.stealthMaster) applyMasterStealth(true);
  const keep = sel.value && sel.value !== 'auto' ? sel.value : c.captureDisplay;
  sel.innerHTML =
    '<option value="auto">Auto screen</option>' +
    displays
      .map(
        (d, i) =>
          `<option value="${d.id}">${escapeHtml(d.label || 'Display ' + (i + 1))} · ${d.size.width}×${d.size.height}</option>`,
      )
      .join('');
  sel.value = displays.some((d) => String(d.id) === String(keep)) ? keep : 'auto';
}

(async function initDisplays() {
  await refreshDisplays();
  const sel = document.getElementById('displaySel');
  sel.addEventListener('change', () => api.setConfig({ captureDisplay: sel.value }));
  window.addEventListener('focus', refreshDisplays); // monitors may have changed while away
})();

// utility buttons
document.getElementById('clearHistory').addEventListener('click', () => {
  history = [];
  answerRaw = '';
  transcriptText = '';
  transcriptLog = [];
  lastQuery = null;
  lastAssistantShown = '';
  lastDebrief = '';
  pendingDebrief = false;
  debriefReqId = 0;
  el.answer.textContent = '';
  el.transcript.textContent = 'Press Listen to start capturing audio.';
  el.transcript.classList.add('muted');
  el.shot.hidden = true;
  el.exportMd.hidden = true; // no debrief to export anymore
  setStatus('');
  persistState(); // debounced save of now-empty state
});
document.getElementById('copyAnswer').addEventListener('click', () => {
  if (!answerRaw.trim()) return;
  const btn = document.getElementById('copyAnswer');
  const flash = () => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = orig), 1200);
  };
  const fallback = () => {
    // legacy path: works even when the async Clipboard API is denied
    const ta = document.createElement('textarea');
    ta.value = answerRaw;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
    if (ok) flash();
    else setStatus('Copy failed — clipboard unavailable', true);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(answerRaw).then(flash).catch(fallback);
  } else {
    fallback();
  }
});

// first-run hint
api.getConfig().then((c) => {
  if (!c.hasKey) {
    el.answer.innerHTML = '<span class="muted">No API key yet. Click ⚙ and add any OpenAI-compatible key + base URL.</span>';
  }
});
