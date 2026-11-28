const $ = (id) => document.getElementById(id);
const api = window.glance;

const el = {
  panel: $('panel'),
  status: $('status'), transcript: $('transcript'), answer: $('answer'), shot: $('shot'),
  usage: $('usage'),
  question: $('question'), stop: $('stop'), listen: $('listen'),   source: $('source'),
  recState: $('recState'), recLabel: $('recLabel'),
  consent: $('consent'), consentAccept: $('consentAccept'), consentCancel: $('consentCancel'),
  transcriptSaveState: $('transcriptSaveState'),
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
    const payload = { history, memory: memory.slice(-200) };
    // The transcript is opt-in. Main enforces the same rule, so a stale renderer
    // cannot turn this into a disk write by sending the fields anyway.
    if (appCfg.persistTranscript === true) {
      payload.transcript = transcriptText;
      payload.transcriptLog = transcriptLog.slice(-500);
    }
    api.setState(payload);
  }, 1000);
}

function paintTranscriptSaveState() {
  if (!el.transcriptSaveState) return;
  el.transcriptSaveState.textContent = appCfg.persistTranscript === true
    ? 'saved on this device'
    : 'not saved — cleared on quit';
}

// First-run card: hidden as soon as either a remote key or a local endpoint is
// configured. It is guidance, not a gate; the settings panel still works.
function paintOnboarding() {
  const card = $('onboarding');
  if (!card) return;
  const localReady = Boolean(appCfg.preferLocal && appCfg.localBaseUrl);
  card.hidden = Boolean(appCfg.hasKey || localReady);
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

// User-controlled memory: every note is visible, editable and deletable. The
// model gets the same array the user sees, so there is no hidden profile.
function paintMemory() {
  const list = $('memoryList');
  if (!list) return;
  list.textContent = '';
  const shown = memory.slice(-50);
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'muted small';
    empty.textContent = 'No saved memory yet.';
    list.appendChild(empty);
    return;
  }
  const offset = memory.length - shown.length;
  shown.forEach((note, i) => {
    const index = offset + i;
    const item = document.createElement('div');
    item.className = 'memory-item';
    const meta = document.createElement('div');
    meta.className = 'memory-meta';
    const kind = String(note.kind || 'note');
    meta.textContent = kind + ' · ' + (note.at ? stampAt(note.at) : 'unknown time');
    const text = document.createElement('textarea');
    text.value = String(note.text || '');
    text.rows = 3;
    text.setAttribute('aria-label', 'Memory note');
    text.addEventListener('change', () => {
      const next = text.value.trim();
      if (!next) memory.splice(index, 1);
      else memory[index].text = next;
      persistState();
      paintMemory();
      if ($('memoryMsg')) $('memoryMsg').textContent = 'Saved';
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger tiny';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete this memory note');
    del.addEventListener('click', () => {
      memory.splice(index, 1);
      persistState();
      paintMemory();
      if ($('memoryMsg')) $('memoryMsg').textContent = 'Deleted';
    });
    item.append(meta, text, del);
    list.appendChild(item);
  });
}

// short local stamp for transcript lines: "Oct 23, 2:03 PM"
function stampAt(iso) {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function paintTranscript() {
  el.transcript.classList.remove('muted');
  el.transcript.textContent = transcriptLog
    .map((e) => (e.who ? `[${stampAt(e.at)}] ${e.who}: ${e.text}` : `[${stampAt(e.at)}] ${e.text}`))
    .join('\n');
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
  el.usage.textContent = '';
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
api.onDone(({ id, latencyMs, usage, costUsd }) => {
  if (id !== activeReq) return;
  finish(true, id);
  const bits = [];
  if (typeof latencyMs === 'number') bits.push((latencyMs / 1000).toFixed(1) + 's');
  const tok = usage && (usage.totalTokens || (usage.inputTokens || 0) + (usage.outputTokens || 0));
  if (tok) bits.push(tok + ' tok');
  if (typeof costUsd === 'number') bits.push(costUsd === 0 ? 'local' : '$' + costUsd.toFixed(4));
  el.usage.textContent = bits.join(' · ');
});
api.onNotice(({ level, message }) => {
  setStatus(message, level === 'error');
  // Updates are two explicit clicks: one to download, one to install. Nothing
  // downloads or installs on its own, so the status bar is the whole flow.
  const msg = message || '';
  const ready = /ready - restart to apply/.test(msg);
  const available = /available - click to download/.test(msg);
  el.status.style.cursor = ready || available ? 'pointer' : '';
  el.status.onclick = ready ? () => api.updateInstall()
    : available ? () => api.updateDownload()
    : null;
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
// One stream per speaker. "Both" runs a mic loop and a loopback loop side by
// side so an interview reads as two labelled sides instead of one blended wall;
// transcriptText stays unlabelled because it is what gets sent to the model.
const streams = new Map(); // 'you' | 'them' → MediaStream
let listening = false;
// true while the panel is playing its own speech — the listen loops stand down
// instead of transcribing the app into its own transcript
let speaking = false;
const WHO = { you: 'You', them: 'Them' };

async function openStream(kind) {
  if (kind === 'system') {
    // main process answers with loopback audio; we only keep the audio track
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => t.stop());
    if (!s.getAudioTracks().length) throw new Error('No system audio track available');
    return new MediaStream(s.getAudioTracks());
  }
  // Browser-level cleanup before the chunk leaves the machine: echo cancellation
  // keeps meeting audio out of the mic track (loopback already captures it),
  // noise suppression handles fans and keyboards, and AGC keeps a quiet headset
  // audible. If a driver rejects the constraint set, plain audio still works.
  const wanted = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: wanted });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

// Record until a pause rather than until a stopwatch. A fixed cut lands inside a
// word about as often as between two, and a word cut in half is gone: the model
// never sees the other half. Ending the chunk in quiet means the boundary falls
// between words, so consecutive chunks join back into the sentence they came from.
const SPEECH_RMS = 0.008;

function recordOnce(who, ms, { minMs = 0, quietMs = 0, src = streams.get(who) } = {}) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);    const rec = new MediaRecorder(src);
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    let node = null;
    let timer = null;
    rec.onstop = () => {
      clearInterval(timer);
      try { node && node.disconnect(); } catch {}
      resolve(new Blob(parts, { type: rec.mimeType }));
    };
    rec.start();
    const started = Date.now();
    if (quietMs > 0) {
      try {
        const ctx = audioCtx();
        node = ctx.createMediaStreamSource(src);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        node.connect(analyser);
        const frame = new Float32Array(analyser.fftSize);
        let lastLoud = Date.now();
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(frame);
          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          if (Math.sqrt(sum / frame.length) > SPEECH_RMS) lastLoud = Date.now();
          if (Date.now() - started >= minMs && Date.now() - lastLoud >= quietMs && rec.state !== 'inactive') rec.stop();
        }, 80);
      } catch {}
    }
    setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, ms);
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
    const { buf, mime, who } = transcribeQueue.shift();
    try {
      const r = await api.transcribe(buf, mime, who);
      if (r.error) {
        setStatus(r.error.slice(0, 80), true);
        continue;
      }
      const text = (r.text || '').trim();
      if (!text) continue;
      // Provider-diarized text already carries its own speaker labels, so the
      // capture-source label ("You"/"Them") would be a second, wrong label.
      // The model still gets the plain text, not the screenplay formatting.
      const whoLabel = r.diarized ? null : who;
      const plain = (r.plain || text).trim();
      const last = transcriptLog[transcriptLog.length - 1];
      const continues = last && last.who === whoLabel && /[a-z0-9,;:]$/.test(last.text);
      if (continues) {
        // same speaker, previous line did not finish a sentence: keep one line
        last.text = (last.text + ' ' + text).replace(/\s+/g, ' ').trim();
        last.at = new Date().toISOString();
      } else {
        transcriptLog.push({ at: new Date().toISOString(), text, who: whoLabel });
      }
      transcriptText += (transcriptText ? ' ' : '') + plain;
      // Long sessions must not grow without bound: keep the most recent text
      // (the model only ever receives the tail) and cap the rendered log.
      if (transcriptText.length > 300000) {
        const cut = transcriptText.length - 300000;
        transcriptText = transcriptText.slice(cut);
        copilotSince = Math.max(0, copilotSince - cut);
      }
      if (transcriptLog.length > 2000) transcriptLog = transcriptLog.slice(-2000);
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

function enqueueChunk(buf, mime, who) {
  if (transcribeQueue.length >= MAX_QUEUE) {
    transcribeQueue.shift();
    setStatus('Audio backlog — dropping oldest chunk', true);
  }
  transcribeQueue.push({ buf, mime, who });
  if (!transcribeWorker) transcribeWorker = drainQueue();
}

async function listenLoop(who, src = streams.get(who)) {
  while (listening && streams.get(who) === src) {
    // do not record while the panel is speaking: that audio is on the same
    // output device the loopback taps
    while (speaking && listening) await new Promise((r) => setTimeout(r, 150));
    if (!listening || streams.get(who) !== src) break;
    const blob = await recordOnce(who, CHUNK_MS, {
      minMs: Math.max(900, Math.round(CHUNK_MS * 0.7)),
      quietMs: 240,
      src,
    });
    // A device swap replaces the stream mid-chunk: this loop belongs to the old
    // one, so it must not enqueue a chunk the replacement loop also records.
    if (streams.get(who) !== src) break;
    if (!blob || !listening) break; // Stop arrived while this chunk was recording — do not enqueue it
    if (blob.size < 2000) continue; // near-silence / empty
    const buf = await blob.arrayBuffer();
    if (await isSilent(buf)) continue; // save an API call on silent chunks
    enqueueChunk(buf, blob.type, WHO[who]);
  }
}

function stopAllStreams() {
  for (const s of streams.values()) s.getTracks().forEach((t) => t.stop());
  streams.clear();
}

// A microphone can disappear mid-session: USB unplug, Bluetooth drop, device
// sleep, or a loopback share that the OS closes. The old loop simply went quiet
// forever while the UI still said "Listening". Re-open the same source with a
// bounded retry, keep the transcript queue, and say what happened.
const recoveryAttempts = new Map();
const recovering = new Set();

function watchStream(who, stream) {
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!listening || streams.get(who) !== stream) return;
      recoverStream(who);
    });
  }
}

async function recoverStream(who) {
  if (!listening || recovering.has(who) || streams.has(who)) return;
  recovering.add(who);
  const attempt = (recoveryAttempts.get(who) || 0) + 1;
  recoveryAttempts.set(who, attempt);
  const label = who === 'them' ? 'System audio' : 'Microphone';
  try {
    if (attempt > 3) {
      setStatus(`${label} disconnected — press Stop, then Listen to retry.`, true);
      return;
    }
    setStatus(`${label} disconnected — reconnecting (${attempt}/3)…`, true);
    await new Promise((r) => setTimeout(r, 400 * attempt));
    if (!listening) return;
    const stream = await openStream(who === 'them' ? 'system' : 'mic');
    if (!listening) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streams.set(who, stream);
    watchStream(who, stream);
    recoveryAttempts.delete(who);
    setStatus(`${label} reconnected`);
    listenLoop(who, stream).catch((err) => setStatus('Listen loop error: ' + err.message, true));
  } catch (err) {
    setStatus(`${label} still unavailable: ${String(err.message || err).slice(0, 70)}`, true);
    if (listening && attempt < 3) {
      setTimeout(() => recoverStream(who).catch(() => {}), 1200 * attempt);
    }
  } finally {
    recovering.delete(who);
  }
}

// ---------- capture consent + visible indicator ----------
// A red pill is shown for as long as a microphone or loopback stream is open.
// The consent notice is blocking: no stream is opened until the user agrees, and
// the agreement is stored (with a timestamp) so it can be withdrawn in Settings.
let consentPromise = null;

function paintListeningIndicator() {
  if (!el.recState) return;
  el.recState.hidden = !listening;
  if (!listening) return;
  const source = el.source.value;
  el.recLabel.textContent =
    source === 'both' ? 'Listening — mic + speakers' : source === 'system' ? 'Listening — speakers' : 'Listening — mic';
}

function ensureAudioConsent() {
  if (appCfg.audioConsent === true) return Promise.resolve(true);
  if (consentPromise) return consentPromise;
  el.consent.hidden = false;
  el.consentAccept.focus();
  consentPromise = new Promise((resolve) => {
    const finish = (ok) => {
      el.consent.hidden = true;
      el.consentAccept.removeEventListener('click', onAccept);
      el.consentCancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      consentPromise = null;
      if (ok) el.listen.focus();
      resolve(ok);
    };
    const onAccept = async () => {
      try {
        const c = await api.setConfig({ audioConsent: true, audioConsentAt: new Date().toISOString() });
        if (c && c.audioConsent === true) {
          appCfg = c;
          finish(true);
          return;
        }
      } catch {}
      setStatus('Could not save audio consent — try again', true);
      finish(false);
    };
    const onCancel = () => finish(false);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };
    el.consentAccept.addEventListener('click', onAccept);
    el.consentCancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
  return consentPromise;
}

async function toggleListen() {
  if (listening) {
    listening = false;
    stopAllStreams();
    el.listen.classList.remove('on');
    el.listen.textContent = 'Listen';
    el.listen.disabled = false;
    paintListeningIndicator();
    setStatus('');
    if (practiceLive) runPracticeDebrief();
    return;
  }
  // Blocking, explicit consent before the first microphone or loopback stream.
  // A user who cancels stays exactly where they were: nothing is opened.
  if (!(await ensureAudioConsent())) return;
  el.listen.disabled = true;
  const source = el.source.value;
  // which loops to start. "both" hears the interviewer and you at once.
  const wanted = source === 'both' ? ['them', 'you'] : source === 'system' ? ['them'] : ['you'];
  let failed = [];
  for (const who of wanted) {
    try {
      // a system loop must be requested from the loopback path; a mic loop from
      // getUserMedia. The label decides the display name, the path is by kind.
      const stream = await openStream(who === 'them' ? 'system' : 'mic');
      streams.set(who, stream);
      watchStream(who, stream);
      recoveryAttempts.delete(who);
    } catch (err) {
      failed.push(`${who === 'them' ? 'system audio' : 'mic'}: ${err.message}`);
    }
  }
  if (!streams.size) {
    el.listen.disabled = false;
    paintListeningIndicator();
    return setStatus('Audio: ' + failed.join('; '), true);
  }
  if (failed.length) setStatus('Partial audio — ' + failed.join('; '), true);
  listening = true;
  el.listen.classList.remove('on');
  el.listen.classList.add('on');
  el.listen.textContent = 'Stop';
  el.listen.disabled = false;
  paintListeningIndicator();
  if (appCfg.practiceMode) {
    // practice session: record and transcribe, but no live answers
    practiceLive = true;
    el.answer.innerHTML = '<span class="muted">Practice session recording — answers stay hidden. Press Stop for your scored debrief.</span>';
    setStatus('Practice recording…');
  } else {
    setStatus(wanted.length > 1 ? 'Listening to both sides…' : 'Listening…');
  }
  for (const [who, stream] of streams) {
    listenLoop(who, stream).catch((err) => {
      setStatus('Listen loop error: ' + err.message, true);
      if (listening) toggleListen();
    });
  }
}
el.listen.addEventListener('click', toggleListen);
el.source.addEventListener('change', paintListeningIndicator);

// ---------- hotkey triggers from main ----------
api.onTrigger((what) => {
  if (what === 'ask-screen') askScreen();
  else if (what === 'toggle-listen') toggleListen();
  else if (what === 'answer-transcript') answerFromTranscript();
});
api.onClickThrough((on) => document.body.classList.toggle('click-through', on));

// ---------- settings ----------
const fields = ['baseUrl', 'chatModel', 'chatProvider', 'transcribeModel', 'transcribeProvider',
  'ttsProvider', 'systemPrompt', 'transcribeLanguage',
  'transcribeBaseUrl', 'ttsBaseUrl', 'ttsVoice', 'ttsModel',
  'targetRole', 'resume', 'knowledge', 'embeddingModel', 'embeddingBaseUrl', 'answerLang', 'answerStyle', 'contextTokens',
  'fallbackBaseUrl', 'fallbackChatModel', 'fallbackProvider',
  'localBaseUrl', 'localChatModel', 'embeddingModel', 'embeddingBaseUrl', 'pricingOverrides'];
// secrets are never read back from main; they submit blank and main keeps the stored value
const keyFields = ['apiKey', 'transcribeApiKey', 'ttsApiKey', 'fallbackApiKey'];
const hasFlag = {
  apiKey: 'hasKey', transcribeApiKey: 'hasTranscribeKey',
  ttsApiKey: 'hasTtsKey', fallbackApiKey: 'hasFallbackKey',
};
// Secrets are never sent back to the renderer. A saved key shows as a
// placeholder instead, so the field is visibly "set" without exposing it, and a
// blank submit means "keep what is stored" rather than "delete".
function paintKeyPlaceholders(c) {
  for (const f of keyFields) {
    const input = $('s_' + f);
    if (!input) continue;
    const saved = Boolean(c && c[hasFlag[f]]);
    input.placeholder = saved ? '•••••• saved — leave blank to keep' : '';
    input.setAttribute('aria-description', saved ? 'A key is saved. Leave blank to keep it.' : '');
  }
}
﻿const boolFields = ['stealth', 'smartMode', 'practiceMode', 'ocr', 'nvidiaEyeContact', 'persistTranscript', 'preferLocal', 'transcribeDiarize'];

// Privacy dashboard: a plain-language answer to "what is stored, and where does
// it go?" computed from the same config and memory the app actually uses.
function paintPrivacy(c) {
  const keys = [
    c.hasKey && 'chat',
    c.hasTranscribeKey && 'transcription',
    c.hasTtsKey && 'TTS',
    c.hasFallbackKey && 'backup',
  ].filter(Boolean);
  $('privacyKeys').textContent = keys.length
    ? keys.join(', ') + ' — encrypted with the OS keystore, never shown again'
    : 'none saved';
  $('privacyTranscript').textContent = c.persistTranscript
    ? 'saved encrypted on this device (turn off to delete it)'
    : 'memory only — erased when Glance quits';
  $('privacyMemory').textContent = memory.length + ' note(s) — edit or delete any of them above';
  $('privacyRouting').textContent = c.preferLocal && c.localBaseUrl
    ? 'local model first (' + (c.localChatModel || 'default') + '), then ' + (c.chatProvider === 'auto' ? 'auto-detected provider' : c.chatProvider)
    : (c.chatProvider === 'auto' ? 'auto-detected provider' : c.chatProvider) + ' only';
  $('privacyRetrieval').textContent = c.embeddingModel
    ? 'embeddings: ' + c.embeddingModel + ' — note text goes to that endpoint'
    : 'fully local — note text never leaves this device';
}

async function openSettings() {
  lastSettingsFocus = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : $('gear');
  const c = await api.getConfig();
  fields.forEach((f) => ($('s_' + f).value = c[f] || ''));
  for (const f of keyFields) $('s_' + f).value = '';
  paintKeyPlaceholders(c);
  boolFields.forEach((f) => ($('s_' + f).checked = Boolean(c[f])));
  // Which camera Broadcast is feeding, and whether eye contact is live. The
  // effect itself is NVIDIA's; this row only drives it.
  try {
    const nv = api.broadcastStatus ? await api.broadcastStatus() : null;
    if ($('s_nvidiaMsg')) {
      $('s_nvidiaMsg').textContent = nv && nv.ok
        ? '— camera: ' + (nv.camera || 'none') + (nv.resolution ? ' @ ' + nv.resolution : '') + ', ' + (nv.eyeContact ? 'on' : 'off')
        : '— ' + ((nv && nv.reason) || 'Broadcast not running');
    }
  } catch {}
  $('s_panelOpacity').value = c.panelOpacity ?? 0.78;
  $('opacityVal').textContent = Math.round((c.panelOpacity ?? 0.78) * 100) + '%';
  $('s_msg').textContent = '';
  paintMemory();
  paintPrivacy(c);
  el.settings.hidden = false;
  el.settings.scrollTop = 0; // reopening must land on the top fields, not wherever it was last scrolled
  refreshModels(); // async — fills the dropdowns once the provider answers
  // Keyboard and screen-reader users land on the first control, not at the top
  // of the document, and get focus back on the gear when the dialog closes.
  const first = el.settings.querySelector('select, input, button');
  if (first) first.focus();
}

let lastSettingsFocus = null;
function closeSettings() {
  if (el.settings.hidden) return;
  el.settings.hidden = true;
  (lastSettingsFocus || $('gear')).focus();
}
// A modal settings panel keeps Tab inside it; without this, focus walks into
// the panel behind the overlay and the dialog stops being modal for keyboards.
el.settings.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const focusable = [...el.settings.querySelectorAll('select, input, textarea, button, [tabindex]:not([tabindex="-1"])')]
    .filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

// provider health: one row per configured provider, no keys in the response
$('s_checkProviders').addEventListener('click', async () => {
  const btn = $('s_checkProviders');
  const list = $('providerHealth');
  btn.disabled = true;
  $('s_healthMsg').textContent = 'Checking…';
  list.textContent = '';
  const r = await api.providerHealth();
  btn.disabled = false;
  if (!r || r.error) {
    $('s_healthMsg').textContent = (r && r.error) || 'Health check failed';
    return;
  }
  $('s_healthMsg').textContent = r.providers.length + ' provider(s) checked';
  for (const p of r.providers) {
    const row = document.createElement('div');
    row.className = 'health-row ' + (p.ok ? 'ok' : 'bad');
    const dot = document.createElement('i');
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('b');
    label.textContent = p.role;
    const detail = document.createElement('span');
    detail.textContent = p.ok
      ? `${p.kind} @ ${p.host} — ${p.latencyMs} ms, ${p.models} model(s)`
      : `${p.kind} @ ${p.host} — ${p.error}`;
    row.append(dot, label, detail);
    list.appendChild(row);
  }
});

// Deep provider test: one tiny real completion, so a gateway that lists models
// but cannot chat is caught before the interview starts.
$('s_testChat').addEventListener('click', async () => {
  const btn = $('s_testChat');
  const msg = $('s_testMsg');
  btn.disabled = true;
  msg.textContent = 'Testing…';
  const r = await api.providerTest();
  btn.disabled = false;
  if (!r || r.error) {
    msg.textContent = (r && r.error) || 'Test failed';
    return;
  }
  msg.textContent = r.ok
    ? `${r.kind} ${r.model} — ${r.latencyMs} ms, replied ${JSON.stringify(r.text || '')}`
    : `${r.model} — ${r.error}`;
});

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
      provider: purpose === 'chat'
        ? $('s_chatProvider').value
        : purpose === 'transcribe' ? $('s_transcribeProvider').value : $('s_ttsProvider').value,
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
for (const id of ['s_baseUrl', 's_apiKey', 's_transcribeBaseUrl', 's_transcribeApiKey', 's_ttsBaseUrl', 's_ttsApiKey',
  's_chatProvider', 's_transcribeProvider', 's_ttsProvider']) {
  $(id).addEventListener('change', refreshModelsDebounced);
}

// Switching provider fills the default endpoint only when the field is still
// blank. It never overwrites a URL the user typed, and it never clears a key.
const PROVIDER_PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', model: '' },
};
$('s_chatProvider').addEventListener('change', () => {
  const preset = PROVIDER_PRESETS[$('s_chatProvider').value];
  if (!preset) return;
  if (!$('s_baseUrl').value.trim()) $('s_baseUrl').value = preset.baseUrl;
  if (!$('s_chatModel').value.trim() && preset.model) $('s_chatModel').value = preset.model;
});
$('s_fallbackProvider').addEventListener('change', () => {
  const preset = PROVIDER_PRESETS[$('s_fallbackProvider').value];
  if (preset && !$('s_fallbackBaseUrl').value.trim()) $('s_fallbackBaseUrl').value = preset.baseUrl;
});
$('gear').addEventListener('click', openSettings);
$('onboardingSetup').addEventListener('click', () => openSettings());
$('onboardingLocal').addEventListener('click', async () => {
  const c = await api.setConfig({
    preferLocal: true,
    localBaseUrl: 'http://127.0.0.1:11434/v1',
    localChatModel: 'llama3.2',
  });
  if (!c || c.error) {
    setStatus('Could not save local model settings', true);
    return;
  }
  appCfg = c;
  paintOnboarding();
  setStatus('Local model selected — start Ollama, then ask a question');
  openSettings();
});
$('s_close').addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.settings.hidden) closeSettings();
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
  // download is user-triggered: the notice offers a click, it does not start
  msg.textContent = 'Check requested — a download prompt appears in the status bar';
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
﻿
$('s_importKnowledge').addEventListener('click', async () => {
  const r = await api.importKnowledge();
  if (!r || r.canceled) return;
  if (r.error) {
    $('knowledgeMsg').textContent = r.error;
    return;
  }
  const area = $('s_knowledge');
  const head = '# ' + r.name;
  area.value = (area.value.trim() ? area.value.trim() + '\n\n' + head : head) + '\n' + r.text;
  $('knowledgeMsg').textContent = `Imported ${r.name} — click Save to keep it`;
});

$('s_clearMemory').addEventListener('click', () => {
  if (!memory.length) {
    if ($('memoryMsg')) $('memoryMsg').textContent = 'Nothing to delete.';
    return;
  }
  if (!confirm('Delete every saved memory note? This cannot be undone.')) return;
  memory = [];
  persistState();
  paintMemory();
  if ($('memoryMsg')) $('memoryMsg').textContent = 'All memory deleted.';
});

$('s_save').addEventListener('click', async () => {
  const next = { panelOpacity: parseFloat($('s_panelOpacity').value) };
  keyFields.forEach((f) => (next[f] = $('s_' + f).value.trim()));
  fields.forEach((f) => (next[f] = $('s_' + f).value.trim()));
  boolFields.forEach((f) => (next[f] = $('s_' + f).checked));
  const c = await api.setConfig(next);
  if (!c || c.error) {
    setMsg('Not saved: ' + ((c && c.error) || 'invalid settings'), 'err');
    return;
  }
  appCfg = c; // practiceMode etc. take effect immediately
  paintOnboarding();
  paintTranscriptSaveState();
  if (api.setBroadcastEyeContact) {
    try { await api.setBroadcastEyeContact(Boolean(next.nvidiaEyeContact)); } catch {}
  }
  api.stealthApply?.(Boolean(c.stealth));
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
    provider: $('s_chatProvider').value,
  });
  btn.disabled = false;
  if (r.error) {
    setMsg('✗ Key failed: ' + r.error.slice(0, 120), 'err');
  } else {
    const ms = typeof r.latencyMs === 'number' ? ` in ${r.latencyMs} ms` : '';
    setMsg(`✓ Key works — ${r.models.length} models available${ms} (${new Date().toLocaleTimeString()})`, 'ok');
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
$('s_resetConsent').addEventListener('click', async () => {
  const c = await api.setConfig({ audioConsent: false, audioConsentAt: '' });
  appCfg = c;
  setMsg('Audio consent withdrawn — Listen will ask again.');
});

$('hide').addEventListener('click', () => api.hide());
$('close').addEventListener('click', () => api.quit());

// ---------- Copilot: auto-detect questions, auto-answer ----------
let copilotOn = false;
let copilotTimer = null;
let copilotSince = 0; // transcript length already handled — only inspect new speech
let copilotBusy = false;

// fast mode cuts detection latency: shorter audio chunks + shorter end-of-question debounce
let fastMode = true;
// captions mode is the Zoom-subtitle shape: keep listening, cut the audio into
// 1.5 s pieces so text lands while the sentence is still being spoken. It wins
// over fast mode because the point is latency, not question detection.
let captionMode = false;
let CHUNK_MS = 4000;
let copilotDebounce = 1200;

function modelWantsLongChunks() {
  // a bigger model needs more audio per call to stay real time on a CPU; the
  // name is the only signal the renderer has, and it is the one the user set
  return /small|medium|large/i.test(appCfg.transcribeModel || '');
}

function applyTiming() {
  const base = modelWantsLongChunks() ? 3000 : 1500;
  if (captionMode) {
    CHUNK_MS = base;
    copilotDebounce = 700;
  } else if (fastMode) {
    CHUNK_MS = 4000;
    copilotDebounce = 1200;
  } else {
    CHUNK_MS = 7000;
    copilotDebounce = 2500;
  }
}

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
      // stalled = frames stopped (capture ended, model hung): hide rather than
      // leaving the last camera frame frozen in the corner
      const stalled = Boolean(s.stalled);
      el.eyeHud.hidden = !window.glanceEye.on || stalled;
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
  const apply = () => {
    applyTiming();
    btn.classList.toggle('on', fastMode);
    btn.textContent = 'Fast: ' + (fastMode ? 'on' : 'off');
  };
  btn.addEventListener('click', () => {
    fastMode = !fastMode;
    apply();
    setStatus(fastMode ? 'Fast mode: 4s chunks, 1.2s detection' : 'Normal mode: 7s chunks, 2.5s detection');
  });
  // The default is on, so the chunk length and the button have to follow it at
  // boot rather than only when the button is first pressed.
  apply();
})();

// ---------- captions mode ----------
// The Zoom-subtitle shape: listening starts on launch and the audio is cut into
// 1.5 s pieces, so a line lands while the sentence is still being spoken. The
// state is persisted, so launching Glance is the only thing a user has to do.
function paintCaptions() {
  const btn = document.getElementById('captionsBtn');
  if (!btn) return;
  btn.classList.toggle('on', captionMode);
  btn.textContent = 'Captions: ' + (captionMode ? 'on' : 'off');
}

async function setCaptions(on, { persist = true } = {}) {
  if (on && !(await ensureAudioConsent())) {
    // No consent, no auto-start. Turn the persisted mode off too, or the next
    // launch would ask again without the user touching anything.
    captionMode = false;
    applyTiming();
    paintCaptions();
    try { await api.setConfig({ captionMode: false }); } catch {}
    setStatus('Captions need audio consent — press Listen to review', true);
    return;
  }
  captionMode = Boolean(on);
  applyTiming();
  paintCaptions();
  if (persist) {
    try { await api.setConfig({ captionMode }); } catch {}
  }
  if (captionMode) {
    if (!listening) {
      const b = document.getElementById('listen');
      if (b && b.textContent !== 'Stop') toggleListen();
    }
    setStatus('Captions: listening, 1.5s chunks');
  }
}

(function initCaptions() {
  paintCaptions();
  const btn = document.getElementById('captionsBtn');
  if (btn) btn.addEventListener('click', () => setCaptions(!captionMode));
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
  const player = new Audio('data:audio/mp3;base64,' + r.audio);
  // The panel's own voice goes out through the default output device, which is
  // exactly what the loopback records — without this the transcript would contain
  // Glance reading its own answers back.
  speaking = true;
  if (listening) el.recLabel.textContent = 'Speaking — listening paused';
  const done = () => { speaking = false; paintListeningIndicator(); };
  player.onended = done;
  player.onerror = done;
  player.play().catch(done);
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
  document.body.style.background = 'transparent';
  const brandEl = document.querySelector('.brand');
  if (brandEl) brandEl.textContent = 'Glance AI';
  applyOpacity(c.panelOpacity);
  // Re-assert capture exclusion once the window exists, then once more after it
  // settles. This is the same documented call the settings toggle makes.
  const applyStealth = () => api.stealthApply?.(Boolean(c.stealth));
  applyStealth();
  setTimeout(applyStealth, 1500);
  const keep = sel.value && sel.value !== 'auto' ? sel.value : c.captureDisplay;
  sel.innerHTML =
    '<option value="auto">Auto screen</option>' +
    displays
      .map((d, i) => {
        // screens carry a size, single-window targets do not; dereferencing it
        // unconditionally threw here on every launch and left the picker empty
        const dims = d.size ? ' \u00b7 ' + d.size.width + '\u00d7' + d.size.height : ' \u00b7 window';
        return '<option value="' + d.id + '">' + escapeHtml(d.label || 'Display ' + (i + 1)) + dims + '</option>';
      })
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
  appCfg = c;
  paintTranscriptSaveState();
  paintListeningIndicator();
  paintOnboarding();
  if (!c.hasKey) {
    el.answer.innerHTML = '<span class="muted">No API key yet. Click ⚙ and add any OpenAI-compatible key + base URL, or use a local model.</span>';
  }
  // Captions mode resumes by itself only after consent. If consent is missing,
  // setCaptions shows the same blocking notice Listen uses and leaves the mode
  // off if the user cancels.
  if (c.captionMode) setTimeout(() => setCaptions(true, { persist: false }).catch(() => {}), 1200);
  // the chunk length depends on the configured model, which is only known now
  applyTiming();
});


