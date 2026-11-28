'use strict';
// Optional semantic retrieval for the knowledge base.
//
// Default retrieval is lexical (src/shared.js): no network, no note text leaves
// the machine. When the user sets an embedding model, this module asks that
// endpoint for one vector per note and adds a bounded cosine boost to the same
// ranking. It is deliberately fail-open: a slow, missing or broken endpoint
// falls back to lexical retrieval, so the answer still arrives.
//
// Key rule: the chat key is reused only when the embedding endpoint is the same
// origin as the chat endpoint. A different origin gets no key (the local-model
// case), so configuring embeddings can never exfiltrate the stored credential.

const crypto = require('crypto');
const providers = require('./providers');
const { splitNotes, rankNotes } = require('./shared');

const BATCH = 64;
const MAX_BLOCKS = 300; // above this, one embedding pass costs more than it saves
const MAX_CACHE = 5000;
const TIMEOUT_MS = 8000;

const cache = new Map(); // `${kind}|${baseUrl}|${model}|${sha}` -> number[]

function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Build the descriptor for the embedding endpoint. Returns null when embeddings
// are off, the URL is unusable, or the provider family has no embedding route.
function providerFor(cfg) {
  const model = String((cfg && cfg.embeddingModel) || '').trim();
  if (!model) return null;
  const base = String((cfg.embeddingBaseUrl || (cfg && cfg.baseUrl)) || '').trim();
  if (!base) return null;
  let origin;
  try {
    const u = new URL(base);
    // Note text is the payload here, so a public http:// endpoint fails closed
    // even if the config was hand-edited after validation.
    if (u.protocol === 'http:' && !providers.isLoopbackHost(u.hostname)) return null;
    origin = u.origin;
  } catch {
    return null;
  }
  const kind = providers.normalizeKind('auto', base);
  if (!providers.supportsEmbeddings(kind)) return null;
  let chatOrigin = null;
  try {
    chatOrigin = cfg.baseUrl ? new URL(cfg.baseUrl).origin : null;
  } catch {}
  return providers.descriptor({
    kind,
    baseUrl: base,
    model,
    label: 'embeddings',
    apiKey: origin === chatOrigin ? cfg.apiKey : '',
  });
}

function keyFor(provider, text) {
  return `${provider.kind}|${provider.baseUrl}|${provider.model}|${hashText(text)}`;
}

async function fetchEmbeddings(provider, texts) {
  const req = providers.embeddingRequest(provider, texts);
  if (!req) throw new Error('provider has no embedding route');
  const res = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('embeddings ' + res.status);
  const vectors = providers.parseEmbeddings(await res.json());
  if (!vectors || vectors.length !== texts.length) throw new Error('embedding count mismatch');
  return vectors;
}

// One vector per distinct text, batched, cached by content hash. The cache is
// per-process and keyed by endpoint + model, so switching models never mixes
// vectors from different spaces.
async function embedAll(provider, docs, query) {
  const texts = [...docs, query];
  const missing = [];
  for (const text of texts) {
    if (!cache.has(keyFor(provider, text)) && !missing.includes(text)) missing.push(text);
  }
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const vectors = await fetchEmbeddings(provider, batch);
    for (let j = 0; j < batch.length; j++) {
      if (cache.size >= MAX_CACHE) cache.clear();
      cache.set(keyFor(provider, batch[j]), vectors[j]);
    }
  }
  return {
    docs: docs.map((text) => cache.get(keyFor(provider, text))),
    query: cache.get(keyFor(provider, query)),
  };
}

// Rank knowledge for one question. Always returns a string; never throws.
async function rankKnowledge(cfg, knowledge, query, { onError } = {}) {
  const q = String(query || '').trim();
  const blocks = splitNotes(knowledge);
  if (!blocks.length || !q) return '';
  const provider = providerFor(cfg);
  if (provider && blocks.length <= MAX_BLOCKS) {
    try {
      const { docs, query: qv } = await embedAll(provider, blocks, q);
      if (qv && docs.every(Boolean)) {
        return rankNotes(knowledge, q, {
          withLabels: true,
          embeddingScores: docs.map((v) => cosine(v, qv)),
        });
      }
    } catch (err) {
      if (typeof onError === 'function') onError(err);
    }
  }
  return rankNotes(knowledge, q, { withLabels: true });
}

function clearCache() {
  cache.clear();
}

module.exports = { cosine, hashText, providerFor, rankKnowledge, clearCache };
