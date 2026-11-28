// Unit tests for the pure helpers in src/shared.js. Run: npm test
const assert = require('assert');
const path = require('path');
const { estimateTokens, fitContext, visionTokens, looksLikeQuestion, fitFrames, MIN_TEXT_TOKENS, rankNotes } = require(path.join(__dirname, '..', 'src', 'shared'));
const providers = require(path.join(__dirname, '..', 'src', 'providers'));
const logging = require(path.join(__dirname, '..', 'src', 'logging'));
const signIdentity = require(path.join(__dirname, 'sign-identity'));

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

// ---------- rankNotes: local knowledge retrieval ----------
const NOTES = [
  'Led the payments migration at Acme, moving 40 services off a monolith onto Postgres 14 with zero downtime over nine months.',
  'Kubernetes: ran a 60-node EKS cluster, cut deploy time from 35 to 4 minutes, owned the Helm chart library.',
  'Conflict: my tech lead and I disagreed about a rewrite; I shipped a spike to settle it with numbers instead of opinions.',
  'Unrelated: the office coffee machine is on the third floor and takes oat pods.',
].join('\n\n');

ok('rankNotes returns the block that matches the question', () => {
  const got = rankNotes(NOTES, 'how did you handle a conflict with your lead?');
  assert.match(got, /tech lead/i);
  assert.doesNotMatch(got, /coffee machine/i);
});
ok('rankNotes keeps a payments question away from the conflict story', () => {
  const got = rankNotes(NOTES, 'tell me about the payments migration');
  assert.match(got, /payments/i);
  assert.doesNotMatch(got, /conflict/i);
});
ok('rankNotes returns nothing when no block overlaps', () => {
  assert.strictEqual(rankNotes(NOTES, 'quantum chromodynamics'), '');
});
ok('rankNotes respects maxBlocks and maxChars', () => {
  const many = Array.from({ length: 8 }, (_, i) => `kafka topic ${i}: partitions and consumer lag under rebalance`).join('\n\n');
  assert.ok(rankNotes(many, 'kafka partitions rebalance', { maxBlocks: 2 }).split('\n\n').length <= 2);
  assert.ok(rankNotes(many, 'kafka partitions rebalance', { maxChars: 120 }).length <= 200);
});
ok('rankNotes tolerates empty knowledge and empty query', () => {
  assert.strictEqual(rankNotes('', 'anything'), '');
  assert.strictEqual(rankNotes(NOTES, ''), '');
});

ok('rankNotes prefers an exact phrase over scattered terms', () => {
  const notes = [
    'Payments migration: moved the ledger to Postgres with zero downtime.',
    'Migration of the payments service: the ledger rewrite took nine months and two teams.',
  ].join('\n\n');
  const got = rankNotes(notes, 'payments migration');
  assert.match(got.split('\n\n')[0], /^Payments migration/);
});

ok('rankNotes can label each block with its source heading', () => {
  const got = rankNotes(NOTES, 'tell me about the payments migration', { withLabels: true });
  assert.match(got, /^\[note: Led the payments migration/);
  assert.match(got, /Led the payments migration at Acme/);
});

ok('rankNotes weights a rare term above a term every note shares', () => {
  const notes = [
    'Kubernetes cluster work on the platform team.',
    'Kubernetes and Terraform on the platform team.',
    'Kubernetes on the platform team, plus a Kafka rebalance project.',
  ].join('\n\n');
  const got = rankNotes(notes, 'kafka');
  assert.match(got, /Kafka rebalance/);
  assert.doesNotMatch(got, /Terraform/);
});

// ---------- provider abstraction ----------
ok('provider kind is inferred from the URL for old profiles', () => {
  assert.strictEqual(providers.normalizeKind('auto', 'https://api.anthropic.com/v1'), 'anthropic');
  assert.strictEqual(providers.normalizeKind('auto', 'http://127.0.0.1:11434/v1'), 'ollama');
  assert.strictEqual(providers.normalizeKind('auto', 'http://localhost:1234/v1'), 'lmstudio');
  assert.strictEqual(providers.normalizeKind('auto', 'https://api.openai.com/v1'), 'openai');
  assert.strictEqual(providers.normalizeKind('anthropic-compatible'), 'anthropic');
});

ok('provider base URLs are normalised without double slashes', () => {
  assert.strictEqual(providers.normalizeBaseUrl('openai', 'https://api.test/v1///'), 'https://api.test/v1');
  assert.strictEqual(providers.normalizeBaseUrl('anthropic', 'https://api.anthropic.com'), 'https://api.anthropic.com/v1');
  assert.strictEqual(providers.normalizeBaseUrl('anthropic', 'https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1');
  assert.strictEqual(providers.normalizeBaseUrl('ollama', ''), 'http://127.0.0.1:11434/v1');
});

ok('OpenAI-compatible chat requests keep the existing wire shape', () => {
  const p = providers.descriptor({ kind: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm1' });
  const req = providers.chatRequest(p, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 99 });
  assert.strictEqual(req.url, 'https://api.test/v1/chat/completions');
  assert.strictEqual(req.headers.Authorization, 'Bearer sk-test');
  assert.strictEqual(req.body.model, 'm1');
  assert.strictEqual(req.body.max_tokens, 99);
  assert.strictEqual(req.body.stream, true);
});

ok('Anthropic requests use x-api-key, a separate system prompt and image blocks', () => {
  const p = providers.descriptor({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', model: 'claude-sonnet-4' });
  const b64 = Buffer.from('jpeg').toString('base64');
  const req = providers.chatRequest(p, {
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'look' },
      { role: 'user', content: [
        { type: 'text', text: 'at this' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ] },
    ],
    maxTokens: 321,
  });
  assert.strictEqual(req.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(req.headers['x-api-key'], 'sk-ant');
  assert.strictEqual(req.headers.Authorization, undefined);
  assert.strictEqual(req.headers['anthropic-version'], '2023-06-01');
  assert.strictEqual(req.body.system, 'be brief');
  assert.strictEqual(req.body.max_tokens, 321);
  assert.strictEqual(req.body.messages.length, 1, 'consecutive user turns should be merged');
  const blocks = req.body.messages[0].content;
  assert.strictEqual(blocks[0].type, 'text');
  const image = blocks.find((b) => b.type === 'image');
  assert.ok(image, 'the screenshot should survive the conversion');
  assert.strictEqual(image.source.media_type, 'image/jpeg');
  assert.strictEqual(image.source.data, b64);
});

ok('OpenAI SSE events are normalised', () => {
  assert.deepStrictEqual(providers.parseStreamData('openai', JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })),
    [{ type: 'text', text: 'hi' }]);
  assert.deepStrictEqual(providers.parseStreamData('openai', JSON.stringify({ choices: [{ delta: { reasoning_content: 'why' } }] })),
    [{ type: 'reasoning', text: 'why' }]);
  assert.deepStrictEqual(providers.parseStreamData('openai', '[DONE]'), [{ type: 'done' }]);
  assert.deepStrictEqual(providers.parseStreamData('openai', JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })),
    [{ type: 'usage', usage: { prompt_tokens: 2, completion_tokens: 3 } }]);
});

ok('Anthropic SSE events are normalised', () => {
  assert.deepStrictEqual(
    providers.parseStreamData('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })),
    [{ type: 'text', text: 'hi' }],
  );
  assert.deepStrictEqual(
    providers.parseStreamData('anthropic', JSON.stringify({ type: 'message_stop' })),
    [{ type: 'done' }],
  );
  assert.throws(
    () => providers.parseStreamData('anthropic', JSON.stringify({ type: 'error', error: { message: 'overloaded' } })),
    /overloaded/,
  );
});

ok('non-stream responses are normalised for both families', () => {
  assert.strictEqual(providers.parseResponse('openai', { choices: [{ message: { content: 'hi' } }] }).text, 'hi');
  assert.strictEqual(providers.parseResponse('anthropic', { content: [{ type: 'text', text: 'yo' }] }).text, 'yo');
});

ok('usage is normalised and merged without double counting', () => {
  assert.deepStrictEqual(providers.normalizeUsage({ prompt_tokens: 10, completion_tokens: 4 }),
    { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  assert.deepStrictEqual(providers.normalizeUsage({ input_tokens: 8, output_tokens: 2 }),
    { inputTokens: 8, outputTokens: 2, totalTokens: 10 });
  assert.deepStrictEqual(providers.mergeUsage({ input_tokens: 8, output_tokens: 2 }, { output_tokens: 5 }),
    { inputTokens: 8, outputTokens: 5, totalTokens: 13 });
});

ok('cost estimates are zero for local models and null for unknown models', () => {
  const local = providers.descriptor({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' });
  assert.strictEqual(providers.estimateCostUsd(local, { prompt_tokens: 1000, completion_tokens: 1000 }), 0);
  const known = providers.descriptor({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
  assert.ok(providers.estimateCostUsd(known, { prompt_tokens: 1000000, completion_tokens: 1000000 }) > 0);
  const unknown = providers.descriptor({ kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'some-new-model' });
  assert.strictEqual(providers.estimateCostUsd(unknown, { prompt_tokens: 10, completion_tokens: 10 }), null);
});

ok('pricing overrides reprice an unknown model and ignore malformed lines', () => {
  const model = providers.descriptor({ kind: 'openai', baseUrl: 'https://api.test/v1', model: 'house-model-7b' });
  const usage = { prompt_tokens: 1000000, completion_tokens: 1000000 };
  assert.strictEqual(providers.estimateCostUsd(model, usage), null);
  const map = providers.parsePricingOverrides('house-model-7b = 2, 8\n# comment\nbroken line\nneg = -1, 2');
  assert.deepStrictEqual([...map.keys()], ['house-model-7b']);
  assert.strictEqual(providers.estimateCostUsd(model, usage, map), 10);
  // One number means both directions; case and surrounding spaces do not matter.
  const single = providers.parsePricingOverrides('  HOUSE-Model-7B = 4  ');
  assert.strictEqual(providers.estimateCostUsd(model, usage, single), 8);
  // A known model can be repriced too, and the override wins over the table.
  const known = providers.descriptor({ kind: 'openai', baseUrl: 'https://api.test/v1', model: 'gpt-4o-mini' });
  assert.ok(providers.estimateCostUsd(known, usage, 'gpt-4o-mini = 0, 0') === 0);
});

ok('model lists are parsed from both response shapes', () => {
  assert.deepStrictEqual(providers.parseModels('openai', { data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepStrictEqual(providers.parseModels('ollama', { models: [{ name: 'llama3' }, { name: 'qwen' }] }), ['llama3', 'qwen']);
});

ok('chatChain keeps the backup on its own key and model', () => {
  const chain = providers.chatChain({
    baseUrl: 'https://api.test/v1', apiKey: 'primary', chatModel: 'm1',
    fallbackBaseUrl: 'https://backup.test/v1', fallbackApiKey: 'backup', fallbackChatModel: 'm2',
  });
  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0].apiKey, 'primary');
  assert.strictEqual(chain[1].baseUrl, 'https://backup.test/v1');
  assert.strictEqual(chain[1].apiKey, 'backup');
  assert.strictEqual(chain[1].model, 'm2');
});

ok('local-first routing prepends a keyless local model', () => {
  const chain = providers.chatChain({
    baseUrl: 'https://api.test/v1', apiKey: 'primary', chatModel: 'm1',
    preferLocal: true, localBaseUrl: 'http://127.0.0.1:11434/v1', localChatModel: 'llama3.2',
  });
  assert.strictEqual(chain.length, 2);
  assert.strictEqual(chain[0].label, 'local');
  assert.strictEqual(chain[0].apiKey, '');
  assert.strictEqual(chain[0].model, 'llama3.2');
  assert.strictEqual(chain[1].apiKey, 'primary');
});

ok('audio descriptors never borrow a key for a foreign audio origin', () => {
  const d = providers.audioDescriptor({
    baseUrl: 'https://api.test/v1', apiKey: 'chat-key',
    transcribeBaseUrl: 'https://audio.test/v1', transcribeApiKey: 'audio-key',
    transcribeModel: 'whisper-1',
  }, 'transcribe');
  assert.strictEqual(d.baseUrl, 'https://audio.test/v1');
  assert.strictEqual(d.apiKey, 'audio-key');
  assert.strictEqual(d.model, 'whisper-1');
});

// ---------- structured logging and redaction ----------
ok('log redaction removes keys, bearer tokens and screenshot payloads', () => {
  const text = 'Authorization: Bearer sk-live-1234567890 apiKey=sk-abcdefghijklmnop data:image/jpeg;base64,AAAA////';
  const out = logging.redactSecrets(text);
  assert.doesNotMatch(out, /sk-live|sk-abcdefghijklmnop|AAAA/);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /apiKey=\[redacted\]/);
});

ok('log redaction walks objects but leaves harmless counts alone', () => {
  const out = logging.redactValue({
    apiKey: 'sk-secret-value',
    authorization: 'Bearer abcdef',
    usage: { inputTokens: 10, outputTokens: 2 },
    tokens: 12,
  });
  assert.strictEqual(out.apiKey, '[redacted]');
  assert.strictEqual(out.authorization, '[redacted]');
  assert.strictEqual(out.tokens, 12);
  assert.strictEqual(out.usage.inputTokens, 10);
});

ok('structured log lines are valid JSON with level and event', () => {
  const line = logging.formatLogLine('warn', 'provider.error', { message: 'bad key sk-abcdefghijklmnop', status: 401 });
  const parsed = JSON.parse(line);
  assert.strictEqual(parsed.level, 'warn');
  assert.strictEqual(parsed.event, 'provider.error');
  assert.strictEqual(parsed.status, 401);
  assert.doesNotMatch(parsed.message, /sk-abcdefghijklmnop/);
});

ok('publisher pin matches the same subject in a different RDN order', () => {
  assert.ok(signIdentity.subjectMatches(
    'C=US, O=Glance AI, CN=Glance AI',
    'CN=Glance AI, O=Glance AI, C=US',
  ));
});

ok('publisher pin rejects a certificate with an extra CN suffix', () => {
  assert.ok(!signIdentity.subjectMatches(
    'CN=Glance AI Extra, O=Glance AI, C=US',
    'CN=Glance AI, O=Glance AI, C=US',
  ));
});

ok('publisher pin rejects a certificate that only shares the CN', () => {
  assert.ok(!signIdentity.subjectMatches(
    'CN=Glance AI, O=Somebody Else, C=US',
    'CN=Glance AI, O=Glance AI, C=US',
  ));
});

ok('publisher pin keeps escaped commas inside one RDN value', () => {
  assert.ok(signIdentity.subjectMatches(
    'CN=Glance AI\\, Inc., O=Glance AI, C=US',
    'CN=Glance AI\\, Inc., O=Glance AI, C=US',
  ));
});

console.log(`\n${passed} tests passed`);