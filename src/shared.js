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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { estimateTokens, fitContext, visionTokens, looksLikeQuestion, fitFrames, MIN_TEXT_TOKENS };
}
