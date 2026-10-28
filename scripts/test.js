// Unit tests for the pure helpers in src/shared.js. Run: npm test
const assert = require('assert');
const path = require('path');
const { estimateTokens, fitContext, visionTokens, looksLikeQuestion, fitFrames, MIN_TEXT_TOKENS } = require(path.join(__dirname, '..', 'src', 'shared'));

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('ok  ', name);
}

// ---------- visionTokens ----------
// review-verified anchors: 1920x1080 => 2765 (Anthropic pixels/750 branch), 680x560 => 765 (tile branch)
ok('visionTokens(1920,1080) === 2765', () => assert.strictEqual(visionTokens(1920, 1080), 2765));
ok('visionTokens(680,560) === 765', () => assert.strictEqual(visionTokens(680, 560), 765));
ok('visionTokens is positive for odd sizes', () => assert.ok(visionTokens(1367, 903) > 0));
ok('visionTokens(768,1024) tile branch', () => {
  // 768x1024: tiles = 2*2 = 4 => 85+680 = 765; pixels/750 = 1049 -> 1049
  assert.strictEqual(visionTokens(768, 1024), Math.max(85 + 170 * 4, Math.ceil((768 * 1024) / 750)));
});

// ---------- estimateTokens / fitContext ----------
ok('estimateTokens grows with content and message count', () => {
  const small = estimateTokens([{ role: 'user', content: 'hi' }]);
  const big = estimateTokens([{ role: 'user', content: 'hi'.repeat(400) }, { role: 'user', content: 'there' }]);
  assert.ok(big > small);
});
ok('fitContext drops oldest pairs, keeps system + last turn', () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 20; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) });
  const out = fitContext(msgs, 2000);
  assert.strictEqual(out[0].role, 'system');
  assert.ok(estimateTokens(out) <= 2000 || out.length <= 3);
  assert.ok(out.length >= 3, 'never trims below system + one pair');
  assert.ok(out.length < 21, 'actually trimmed');
});
ok('fitContext preserves order (oldest dropped first)', () => {
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'fourth' },
  ];
  const out = fitContext(msgs, 0); // force maximal trimming (stops at length 3)
  assert.deepStrictEqual(out.map((m) => m.content), ['s', 'third', 'fourth']);
});

// ---------- fitFrames (small-window guard) ----------
const frame = (tokens) => ({ tokens, b64: 'x' });
const maxOutFor = (budget) => Math.min(8192, Math.floor(budget * 0.3));
const fits = (r, budget, maxOut) => r.textBudget + r.frameTokens + maxOut <= budget;

ok('fitFrames keeps every frame when the window is large', () => {
  const budget = 32000, maxOut = maxOutFor(budget);
  const r = fitFrames([frame(2765), frame(2765), frame(2765)], budget, maxOut);
  assert.strictEqual(r.frames.length, 3);
  assert.ok(fits(r, budget, maxOut), `text ${r.textBudget} + frames ${r.frameTokens} + out ${maxOut} > ${budget}`);
});

ok('fitFrames keeps all three frames at 24k without overshooting', () => {
  const budget = 24000, maxOut = maxOutFor(budget);
  const r = fitFrames([frame(2765), frame(2765), frame(2765)], budget, maxOut);
  assert.strictEqual(r.frames.length, 3);
  assert.ok(fits(r, budget, maxOut));
});

ok('fitFrames drops the only frame on a 4k window (V-01 small-budget regression)', () => {
  const budget = 4000, maxOut = maxOutFor(budget);
  const r = fitFrames([frame(visionTokens(1920, 1080))], budget, maxOut);
  assert.strictEqual(r.frames.length, 0, 'a 2 765-token frame cannot share a 4 000-token window');
  assert.ok(fits(r, budget, maxOut));
  assert.ok(r.textBudget >= MIN_TEXT_TOKENS);
});

ok('fitFrames keeps the first frame and drops from the end', () => {
  const budget = 9000, maxOut = maxOutFor(budget);
  const frames = [frame(2000), frame(2000), frame(2000)];
  const r = fitFrames(frames, budget, maxOut);
  assert.ok(r.frames.length < 3, 'three frames cannot fit');
  assert.strictEqual(r.frames[0], frames[0], 'primary frame is kept');
  assert.ok(fits(r, budget, maxOut));
});

ok('fitFrames with no frames returns the plain text budget', () => {
  const budget = 32000, maxOut = maxOutFor(budget);
  const r = fitFrames([], budget, maxOut);
  assert.strictEqual(r.frames.length, 0);
  assert.strictEqual(r.frameTokens, 0);
  assert.strictEqual(r.textBudget, budget - maxOut - 512);
});

// ---------- looksLikeQuestion ----------
const Q = [
  'so, can you walk me through how you would design a rate limiter?',
  'What is your experience with React?',
  'How would you handle a memory leak in production?',
  'okay, tell me about a time you disagreed with a teammate.',
  'Could you explain this code on my screen?',
  'Describe your deployment process.',
  'Why did you leave your last job?',
  'well, how do you prioritize under deadline pressure?',
  'have you worked with postgres?',
  'Do you have any questions for us?',
];
const NOT_Q = [
  'i worked at a fintech for three years',
  'we shipped the migration last quarter',
  'sure, that makes sense',
  'let me think about that for a second',
  'the answer is in the documentation',
  'i would use a token bucket in redis',
  '',
  'random filler words with no question',
];
ok('looksLikeQuestion matches all question fixtures', () => {
  for (const t of Q) assert.ok(looksLikeQuestion(t), `should match: "${t}"`);
});
ok('looksLikeQuestion rejects all non-question fixtures', () => {
  for (const t of NOT_Q) assert.ok(!looksLikeQuestion(t), `should NOT match: "${t}"`);
});
ok('looksLikeQuestion handles split/pending questions (G-08 regression)', () => {
  // question split mid-sentence across chunk boundary — still pending, still a question
  const partial = 'so what would you do if the';
  assert.ok(looksLikeQuestion(partial + ' database goes down?'));
});

console.log(`\n${passed} tests passed`);
