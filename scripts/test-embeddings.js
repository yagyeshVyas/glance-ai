'use strict';
// Async tests for optional embedding retrieval. Run: npm test
//
// These use a mocked fetch: no test ever calls a real provider, and the cache is
// cleared between cases so one test cannot make another pass by accident.

const assert = require('assert');
const path = require('path');
const { rankNotes, splitNotes } = require(path.join(__dirname, '..', 'src', 'shared'));
const providers = require(path.join(__dirname, '..', 'src', 'providers'));
const embeddings = require(path.join(__dirname, '..', 'src', 'embeddings'));

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log('ok  ', name);
}

const NOTES = [
  'Kubernetes platform work: ran a 60-node cluster and cut deploy time from 35 to 4 minutes.',
  'Conflict with my tech lead: we disagreed about a rewrite, so I shipped a spike to settle it with numbers.',
].join('\n\n');

// Conflict is checked first so the mixed query "kubernetes disagreement" lands
// in the conflict space: that is the case where semantics must beat the lexical
// winner (the Kubernetes note), which is exactly what these tests assert.
const vec = (text) => {
  if (/conflict|disagree|disagreement/i.test(text)) return [0, 1, 0];
  if (/kubernetes/i.test(text)) return [1, 0, 0];
  return [0, 0, 1];
};

(async () => {
  await ok('splitNotes keeps only real blocks, using the same split as ranking', () => {
    const blocks = splitNotes('short\n\n' + 'a'.repeat(30) + '\n\n' + 'b'.repeat(40));
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0].length, 30);
  });

  await ok('rankNotes uses embedding scores to reorder notes', () => {
    const query = 'kubernetes disagreement';
    const lexical = rankNotes(NOTES, query);
    assert.match(lexical.split('\n\n')[0], /^Kubernetes/);
    const hybrid = rankNotes(NOTES, query, { embeddingScores: [0, 1] });
    assert.match(hybrid.split('\n\n')[0], /^Conflict/);
  });

  await ok('rankNotes ignores a score array that does not match the blocks', () => {
    const query = 'kubernetes disagreement';
    assert.strictEqual(
      rankNotes(NOTES, query, { embeddingScores: [1] }),
      rankNotes(NOTES, query),
    );
  });

  await ok('embeddingRequest uses /embeddings and the provider auth header', () => {
    const p = providers.descriptor({ kind: 'openai', baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'emb' });
    const req = providers.embeddingRequest(p, ['a', 'b']);
    assert.strictEqual(req.url, 'https://api.test/v1/embeddings');
    assert.strictEqual(req.headers.Authorization, 'Bearer k');
    assert.deepStrictEqual(req.body, { model: 'emb', input: ['a', 'b'] });
    assert.strictEqual(providers.embeddingRequest({ ...p, kind: 'anthropic' }, ['a']), null);
  });

  await ok('parseEmbeddings accepts both wire shapes and rejects garbage', () => {
    assert.deepStrictEqual(providers.parseEmbeddings({ data: [{ embedding: [1, 2] }] }), [[1, 2]]);
    assert.deepStrictEqual(providers.parseEmbeddings({ embeddings: [[3, 4]] }), [[3, 4]]);
    assert.strictEqual(providers.parseEmbeddings({ data: [{ embedding: ['x'] }] }), null);
    assert.strictEqual(providers.parseEmbeddings({ nope: true }), null);
  });

  await ok('cosine is 1 for identical vectors and 0 for orthogonal ones', () => {
    assert.strictEqual(embeddings.cosine([1, 0], [1, 0]), 1);
    assert.strictEqual(embeddings.cosine([1, 0], [0, 1]), 0);
    assert.strictEqual(embeddings.cosine([1, 0], [1]), 0);
  });

  await ok('providerFor reuses the chat key only on the same origin', () => {
    const same = embeddings.providerFor({
      baseUrl: 'https://api.test/v1', apiKey: 'secret', embeddingModel: 'emb',
    });
    assert.strictEqual(same.baseUrl, 'https://api.test/v1');
    assert.strictEqual(same.apiKey, 'secret');
    const local = embeddings.providerFor({
      baseUrl: 'https://api.test/v1', apiKey: 'secret',
      embeddingModel: 'emb', embeddingBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    assert.strictEqual(local.kind, 'ollama');
    assert.strictEqual(local.apiKey, '');
    assert.strictEqual(embeddings.providerFor({ baseUrl: 'https://api.test/v1', embeddingModel: '' }), null);
    // Note text must never cross a public plaintext connection, even if the
    // config file was edited outside the validated Settings path.
    assert.strictEqual(embeddings.providerFor({
      baseUrl: 'https://api.test/v1', embeddingModel: 'emb', embeddingBaseUrl: 'http://api.test/v1',
    }), null);
  });

  const realFetch = global.fetch;
  try {
    let calls = 0;
    global.fetch = async (url, opts) => {
      calls++;
      assert.match(String(url), /\/embeddings$/);
      assert.strictEqual(opts.headers.Authorization, 'Bearer secret');
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: body.input.map((t) => ({ embedding: vec(t) })) }) };
    };
    const cfg = {
      baseUrl: 'https://api.test/v1', apiKey: 'secret', embeddingModel: 'emb',
      knowledge: NOTES,
    };

    await ok('rankKnowledge ranks by embedding and labels the winning source', async () => {
      const out = await embeddings.rankKnowledge(cfg, NOTES, 'kubernetes disagreement');
      assert.match(out.split('\n\n')[0], /^\[note: Conflict/);
      assert.strictEqual(calls, 1, 'one batched request for notes + query');
    });

    await ok('rankKnowledge caches vectors across calls', async () => {
      const before = calls;
      await embeddings.rankKnowledge(cfg, NOTES, 'kubernetes disagreement');
      assert.strictEqual(calls, before);
    });

    await ok('rankKnowledge falls back to lexical when embeddings fail', async () => {
      embeddings.clearCache();
      const before = calls;
      global.fetch = async () => {
        calls++;
        throw new Error('endpoint down');
      };
      let seen = null;
      const out = await embeddings.rankKnowledge(cfg, NOTES, 'kubernetes disagreement', {
        onError: (e) => { seen = e; },
      });
      assert.match(out.split('\n\n')[0], /^\[note: Kubernetes/);
      assert.ok(seen instanceof Error);
      assert.strictEqual(calls, before + 1);
    });
  } finally {
    global.fetch = realFetch;
    embeddings.clearCache();
  }

  console.log(`\n${passed} embedding tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
