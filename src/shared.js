// Pure helpers shared by main (require) and renderer (<script> before renderer.js).
// No Electron or DOM dependencies — this file is unit-testable in plain Node (scripts/test.js).

// rough token estimate: ~4 chars per token, small per-message overhead
function estimateTokens(msgs) {
  return msgs.reduce((n, m) => n + Math.ceil(String(m.content).length / 4) + 4, 0);
}

// Trim history so system prompt + turns stay under the budget
function fitContext(msgs, budget) {
  while (estimateTokens(msgs) > budget && msgs.length > 3) {
    // drop the oldest user/assistant pair after the system prompt
    msgs.splice(1, 2);
  }
  return msgs;
}

// Smallest text budget worth sending. A 4k window with a screenshot cannot hold
// 2 000 tokens of history plus the frame plus the output reserve, and the old
// floor silently overshot the window; dropping the frame is the honest trade.
const MIN_TEXT_TOKENS = 512;

// Decide which captured frames actually fit: frames + reserved output + text must
// stay inside the window. Keeps the primary (first) frame when anything fits at all.
function fitFrames(frames, budget, maxOut) {
  const room = Math.max(1024, budget - maxOut - 512); // frames + text
  const kept = frames.slice();
  let frameTokens = kept.reduce((n, f) => n + (f.tokens || 0), 0);
  while (kept.length && frameTokens > room - MIN_TEXT_TOKENS) {
    frameTokens -= kept.pop().tokens; // drop the last frame first
  }
  return { frames: kept, frameTokens, textBudget: Math.max(MIN_TEXT_TOKENS, room - frameTokens) };
}

// conservative vision cost: larger of OpenAI's tile formula and Anthropic's pixels/750
function visionTokens(w, h) {
  const s = Math.min(2048 / Math.max(w, h), 768 / Math.min(w, h), 1);
  const tw = Math.round(w * s);
  const th = Math.round(h * s);
  const tiles = Math.ceil(tw / 512) * Math.ceil(th / 512);
  return Math.max(85 + 170 * tiles, Math.ceil((w * h) / 750));
}

// heuristic validated against 14 real-speech cases (fixtures in scripts/test.js)
function looksLikeQuestion(tail) {
  const t = tail.trim().toLowerCase();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const sents = t.split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean);
  const last = sents.length ? sents[sents.length - 1] : t;
  return /^((so|okay|alright|well|and|right|yeah)[,.]?\s+)*(what|how|why|tell me about|tell me|describe|explain|walk me through|can you|do you|have you|are you|would you|could you)\b/.test(last.slice(0, 80));
}

// ---------- local knowledge retrieval ----------
// The notes a user pastes (cheat sheet, project list, JD, study notes) are the
// cheapest source of "correct" answers there is: local, offline, and impossible to
// confuse with the model's imagination. Retrieval is deliberately simple — term
// overlap over paragraphs, no embeddings, no network — because it has to run in
// the few milliseconds between a question being heard and the answer starting.
const STOP_WORDS = new Set(('a an the and or but if then than that this these those of in on at to for from by with without into over under ' +
  'is are was were be been being do does did done have has had will would can could should may might must ' +
  'i you he she it we they me my your our their as so such not no yes about what which who whom whose when where why how').split(' '));

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9+#._-]+/)
    .map((w) => w.replace(/^[._-]+|[._-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// Split pasted knowledge into the blocks retrieval scores. One definition, used
// by rankNotes and by the embedding path so both always see the same blocks.
function splitNotes(knowledge) {
  return String(knowledge || '')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 20);
}

// Rank note blocks against a question. Returns the best blocks (score > 0),
// joined by blank lines and capped, or '' when nothing overlaps.
//
// Retrieval is hybrid and local by default: TF-IDF cosine similarity plus an
// exact-phrase bonus and a small heading bonus. No network call and no note text
// leaves the machine just to decide which note is relevant. When the user opts
// into an embedding model, rankNotes accepts its cosine scores and adds a bounded
// semantic boost; the lexical score still decides ties, so an embedding outage
// cannot empty the answer.
function rankNotes(knowledge, query, { maxBlocks = 3, maxChars = 1400, withLabels = false, embeddingScores = null } = {}) {
  const blocks = splitNotes(knowledge);
  if (!blocks.length) return '';
  const qTerms = terms(query);
  const q = new Set(qTerms);
  if (!q.size) return '';
  const emb = Array.isArray(embeddingScores) && embeddingScores.length === blocks.length
    ? embeddingScores
    : null;

  const docs = blocks.map((block) => {
    const list = terms(block);
    const counts = new Map();
    for (const t of list) counts.set(t, (counts.get(t) || 0) + 1);
    return { block, counts };
  });

  // Document frequency across the user's own notes, so a term every block uses
  // (the project name, "experience") counts less than a rare, specific one.
  const df = new Map();
  for (const d of docs) for (const t of d.counts.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 0.5));

  const qWeight = new Map();
  for (const t of q) qWeight.set(t, idf(t));
  const qNorm = Math.sqrt([...qWeight.values()].reduce((s, w) => s + w * w, 0)) || 1;
  const qPhrase = qTerms.join(' ');

  const scored = docs.map((d, i) => {
    let dot = 0;
    let dNorm = 0;
    for (const [t, c] of d.counts) {
      const w = (1 + Math.log(c)) * idf(t);
      dNorm += w * w;
      if (qWeight.has(t)) dot += w * qWeight.get(t);
    }
    const cosine = dot / ((Math.sqrt(dNorm) || 1) * qNorm);
    const text = d.block.toLowerCase().replace(/\s+/g, ' ');
    const phrase = qTerms.length > 1 && text.includes(qPhrase) ? 0.25 : 0;
    const head = text.slice(0, 120);
    let headHits = 0;
    for (const t of q) if (head.includes(t)) headHits++;
    // Bounded semantic boost: a cosine of 1 adds 0.6, a negative/zero one adds
    // nothing. The lexical score remains the spine, so a bad embedding ranking
    // can reorder notes but cannot force an unrelated block in on its own.
    const semantic = emb ? Math.max(0, Math.min(1, Number(emb[i]) || 0)) * 0.6 : 0;
    const score = cosine + phrase + Math.min(0.15, headHits * 0.05) + semantic;
    return { block: d.block, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  let used = 0;
  for (const s of scored) {
    if (s.score <= 0 || picked.length >= maxBlocks) break;
    if (used + s.block.length > maxChars && picked.length) break;
    picked.push(s.block);
    used += s.block.length;
  }
  if (!withLabels) return picked.join('\n\n');
  // A visible source line lets the model say which note it used, and lets the
  // user see exactly what was injected instead of a wall of anonymous text.
  return picked
    .map((block) => {
      const first = block.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 60);
      return `[note: ${first || 'untitled'}]\n${block}`;
    })
    .join('\n\n');
}

// The update notice is the whole update UI: there is no dialog. Keep two
// invariants in one place so a background check cannot lie about state:
//   - once a version is downloaded, a later check for that same version keeps
//     "ready" instead of offering the download again;
//   - while bytes are moving, a check cannot replace the progress line.
function updaterNotice(prev, event) {
  const state = prev && typeof prev === 'object' ? prev : {};
  const notice = (message, level) => ({ ...state, message, level });
  switch (event && event.type) {
    case 'checking':
      if (state.downloading || state.downloadedVersion) return state;
      return notice('Checking for updates.', 'info');
    case 'available':
      if (state.downloadedVersion === event.version) {
        return notice(`Update ${event.version} ready - restart to apply`, 'info');
      }
      if (state.downloading) return state;
      return notice(`Update ${event.version} available - click to download`, 'info');
    case 'downloading':
      return { ...state, downloading: true, message: 'Downloading update...', level: 'info' };
    case 'progress': {
      if (!state.downloading) return state;
      const pct = Math.max(0, Math.min(100, Math.round(Number(event.percent) || 0)));
      return { ...state, message: `Downloading update... ${pct}%`, level: 'info' };
    }
    case 'downloaded':
      return {
        ...state,
        downloading: false,
        downloadedVersion: event.version,
        message: `Update ${event.version} ready - restart to apply`,
        level: 'info',
      };
    case 'error':
      return {
        ...state,
        downloading: false,
        message: 'Update check failed: ' + String(event.error || '').slice(0, 90),
        level: 'warn',
      };
    case 'none':
      if (state.downloading || state.downloadedVersion) return state;
      return notice('Up to date', 'info');
    default:
      return state;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { estimateTokens, fitContext, visionTokens, looksLikeQuestion, fitFrames, MIN_TEXT_TOKENS, rankNotes, splitNotes, terms, updaterNotice };
}
