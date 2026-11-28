// Provider abstraction shared by the main process and the unit tests.
//
// The app started life as "OpenAI-compatible only": one base URL, one key and
// one /chat/completions shape. That is still the default, but it is no longer
// the only shape. This module turns a small provider descriptor into the URL,
// headers and body each family expects, and parses the replies back into the
// same { text, reasoning, usage } events the renderer already understands.
//
// No Electron, DOM or network dependency: everything here is pure so it can be
// exercised in plain Node (scripts/test.js) without a running app.
'use strict';

const PROVIDER_KINDS = ['openai', 'anthropic', 'ollama', 'lmstudio', 'custom'];
const PROVIDER_CHOICES = ['auto', ...PROVIDER_KINDS];
const LOCAL_KINDS = new Set(['ollama', 'lmstudio']);

// The shapes crossing the provider boundary. The project stays plain JavaScript,
// so these are documentation and editor hints, not a compile step; the runtime
// contract is enforced by descriptor(), the IPC validators and the unit tests.
/**
 * @typedef {object} Provider
 * @property {'openai'|'anthropic'|'ollama'|'lmstudio'|'custom'} kind
 * @property {string} label
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 */
/**
 * @typedef {object} Usage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} totalTokens
 */
/**
 * @typedef {object} ChatRequest
 * @property {string} url
 * @property {Record<string, string>} headers
 * @property {object} body
 */

const DEFAULT_BASE_URL = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  custom: '',
};

// Approximate public list prices in USD per 1M tokens. They are deliberately
// coarse: the point is to show a relative cost signal in the UI, not to bill
// anyone. Unknown models return null rather than a made-up number.
const PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-opus-4': { input: 15, output: 75 },
};

function normalizeKind(kind, baseUrl = '') {
  const raw = String(kind || '').trim().toLowerCase();
  if (raw === 'openai-compatible' || raw === 'openai') return 'openai';
  if (raw === 'anthropic-compatible' || raw === 'anthropic') return 'anthropic';
  if (raw === 'lm-studio' || raw === 'lmstudio') return 'lmstudio';
  if (raw === 'ollama') return 'ollama';
  if (raw === 'custom') return 'custom';
  // 'auto' (and anything unrecognised) infers from the URL. This keeps profiles
  // written before provider selection existed working without a migration.
  return inferKind(baseUrl);
}

function inferKind(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || ''));
  } catch {
    return 'openai';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'api.anthropic.com' || host.includes('anthropic')) return 'anthropic';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    if (url.port === '11434') return 'ollama';
    if (url.port === '1234') return 'lmstudio';
  }
  return 'openai';
}

function isLocalKind(kind) {
  return LOCAL_KINDS.has(normalizeKind(kind));
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

function normalizeBaseUrl(kind, baseUrl) {
  let raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw) raw = DEFAULT_BASE_URL[kind] || DEFAULT_BASE_URL.openai;
  // Anthropic's SDK accepts both https://api.anthropic.com and the /v1 form.
  // The HTTP API itself wants /v1/messages, so add the version segment once.
  if (kind === 'anthropic' && !/\/v\d+$/i.test(raw)) raw += '/v1';
  return raw;
}

/**
 * @param {Partial<Provider> & {kind?: string}} input
 * @returns {Provider}
 */
function descriptor(input = {}) {
  const kind = normalizeKind(input.kind, input.baseUrl);
  return {
    kind,
    label: input.label || kind,
    baseUrl: normalizeBaseUrl(kind, input.baseUrl),
    apiKey: String(input.apiKey || ''),
    model: String(input.model || ''),
  };
}

function authHeaders(provider) {
  const headers = {};
  if (provider.kind === 'anthropic') {
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content == null ? '' : content);
  return content
    .map((part) => (part && part.type === 'text' ? String(part.text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

// OpenAI content parts -> Anthropic content blocks. Unknown parts are dropped
// rather than sent in a shape the API will reject.
function toAnthropicBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content || ' ' }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content || ' ') }];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: String(part.text || ' ') });
      continue;
    }
    if (part.type === 'image_url') {
      const raw = part.image_url && part.image_url.url ? String(part.image_url.url) : '';
      const m = /^data:([^;]+);base64,(.+)$/i.exec(raw);
      if (m) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      }
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: ' ' }];
}

function toAnthropicMessages(messages) {
  const system = messages
    .filter((m) => m && m.role === 'system')
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');
  const out = [];
  for (const message of messages) {
    if (!message || message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = toAnthropicBlocks(message.content);
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  }
  // The Messages API rejects an empty conversation. The renderer always sends
  // at least one turn, but a malformed IPC payload should fail clearly instead
  // of becoming a confusing 400.
  if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  return { system, messages: out };
}

/**
 * @param {Provider} provider
 * @param {{messages: object[], maxTokens?: number, stream?: boolean}} opts
 * @returns {ChatRequest}
 */
function chatRequest(provider, { messages, maxTokens, stream = true } = {}) {
  const max = Math.max(1, Math.floor(Number(maxTokens) || 1024));
  if (provider.kind === 'anthropic') {
    const { system, messages: converted } = toAnthropicMessages(messages || []);
    const body = { model: provider.model, messages: converted, max_tokens: max, stream };
    if (system) body.system = system;
    return {
      url: provider.baseUrl + '/messages',
      headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
      body,
    };
  }
  return {
    url: provider.baseUrl + '/chat/completions',
    headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
    body: { model: provider.model, messages: messages || [], stream, max_tokens: max },
  };
}

function modelsRequest(provider) {
  const query = provider.kind === 'anthropic' ? '?limit=100' : '';
  return {
    url: provider.baseUrl + '/models' + query,
    headers: authHeaders(provider),
  };
}

// Anthropic serves messages, not embeddings; every other supported family
// exposes the OpenAI-compatible /embeddings shape, including Ollama and LM Studio.
function supportsEmbeddings(kind) {
  return kind !== 'anthropic';
}

/**
 * @param {Provider} provider
 * @param {string[]} input
 * @returns {ChatRequest|null}
 */
function embeddingRequest(provider, input) {
  if (!supportsEmbeddings(provider.kind)) return null;
  const texts = (Array.isArray(input) ? input : [input]).map((t) => String(t || ''));
  return {
    url: provider.baseUrl + '/embeddings',
    headers: { 'Content-Type': 'application/json', ...authHeaders(provider) },
    body: { model: provider.model, input: texts },
  };
}

// Accept the OpenAI shape ({data:[{embedding}]}) and the older flat shape
// ({embeddings:[[...]]}); return null when the payload is not an embedding list
// so the caller can fall back instead of scoring garbage.
function parseEmbeddings(json) {
  if (!json || typeof json !== 'object') return null;
  const rows = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.embeddings)
      ? json.embeddings
      : null;
  if (!rows) return null;
  const out = [];
  for (const row of rows) {
    const vec = Array.isArray(row) ? row : row && row.embedding;
    if (!Array.isArray(vec) || !vec.length) return null;
    const nums = vec.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    out.push(nums);
  }
  return out;
}

function parseModels(kind, json) {
  if (!json || typeof json !== 'object') return [];
  const rows = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  const out = [];
  for (const row of rows) {
    if (typeof row === 'string') out.push(row);
    else if (row && typeof row === 'object') {
      const id = row.id || row.name || row.model || row.display_name;
      if (typeof id === 'string' && id) out.push(id);
    }
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

// One SSE `data:` payload -> zero or more normalised events. Throwing here is
// intentional: a provider error must reach the retry/failover path, not be
// silently swallowed as an empty chunk.
function parseStreamData(kind, data) {
  const payload = String(data || '').trim();
  if (!payload) return [];
  if (payload === '[DONE]') return [{ type: 'done' }];

  if (kind === 'anthropic') {
    const obj = JSON.parse(payload);
    const type = obj && obj.type;
    if (type === 'content_block_delta') {
      const delta = obj.delta || {};
      if (delta.type === 'text_delta' && delta.text) return [{ type: 'text', text: delta.text }];
      if (delta.type === 'thinking_delta' && delta.thinking) return [{ type: 'reasoning', text: delta.thinking }];
      return [];
    }
    if (type === 'message_start' && obj.message && obj.message.usage) {
      return [{ type: 'usage', usage: obj.message.usage }];
    }
    if (type === 'message_delta' && obj.usage) return [{ type: 'usage', usage: obj.usage }];
    if (type === 'message_stop') return [{ type: 'done' }];
    if (type === 'error') {
      throw new Error((obj.error && obj.error.message) || 'Anthropic stream error');
    }
    return [];
  }

  const parsed = JSON.parse(payload);
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const events = [];
  const reasoning = choice.delta?.reasoning_content ?? choice.message?.reasoning_content ?? '';
  const content = choice.delta?.content ?? choice.message?.content ?? '';
  if (reasoning) events.push({ type: 'reasoning', text: reasoning });
  if (content) events.push({ type: 'text', text: content });
  if (parsed.usage) events.push({ type: 'usage', usage: parsed.usage });
  return events;
}

function parseResponse(kind, json) {
  if (!json || typeof json !== 'object') return { text: '', reasoning: '', usage: null };
  if (kind === 'anthropic') {
    const blocks = Array.isArray(json.content) ? json.content : [];
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
    const reasoning = blocks.filter((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')).map((b) => b.thinking || '').join('');
    return { text, reasoning, usage: json.usage || null };
  }
  const message = (json.choices && json.choices[0] && json.choices[0].message) || {};
  return {
    text: message.content || '',
    reasoning: message.reasoning_content || '',
    usage: json.usage || null,
  };
}

/**
 * @param {object} usage provider usage block in either wire shape
 * @returns {Usage|null}
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? inputTokens + outputTokens) || 0;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function mergeUsage(a, b) {
  const left = normalizeUsage(a);
  const right = normalizeUsage(b);
  if (!left) return right;
  if (!right) return left;
  const inputTokens = Math.max(left.inputTokens, right.inputTokens);
  const outputTokens = Math.max(left.outputTokens, right.outputTokens);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function pricingFor(model, overrides) {
  const name = String(model || '').toLowerCase();
  if (!name) return null;
  // User overrides win: they exist precisely because list prices go stale or a
  // gateway bills a model at a negotiated rate. Exact model match only, so a
  // typo cannot silently reprice an unrelated model.
  if (overrides) {
    const map = overrides instanceof Map ? overrides : parsePricingOverrides(overrides);
    const custom = map.get(name);
    if (custom) return custom;
  }
  for (const key of Object.keys(PRICING)) {
    if (name === key || name.startsWith(key + '-')) return PRICING[key];
  }
  return null;
}

// Parse the settings textarea. One model per line:
//   model-name = inputUSDperMTok, outputUSDperMTok
// A single number means the same rate for both directions. Blank lines and
// lines starting with # are ignored, as is anything malformed — a bad pricing
// line must never break a request or invent a cost.
function parsePricingOverrides(text) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(.+?)\s*=\s*([0-9]*\.?[0-9]+)\s*(?:[,/]\s*([0-9]*\.?[0-9]+))?$/);
    if (!m) continue;
    const input = Number(m[2]);
    const output = m[3] === undefined ? input : Number(m[3]);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue;
    out.set(m[1].trim().toLowerCase(), { input, output });
  }
  return out;
}

function estimateCostUsd(provider, usage, overrides) {
  const u = normalizeUsage(usage);
  if (!u) return null;
  if (provider && (provider.kind === 'ollama' || provider.kind === 'lmstudio')) return 0;
  const price = pricingFor(provider && provider.model, overrides);
  if (!price) return null;
  return (u.inputTokens * price.input + u.outputTokens * price.output) / 1e6;
}

async function healthCheck(provider, fetchImpl = globalThis.fetch, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const req = modelsRequest(provider);
    const res = await fetchImpl(req.url, {
      method: 'GET',
      headers: req.headers,
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      return { ok: false, latencyMs, status: res.status, error: `HTTP ${res.status}: ${detail}` };
    }
    const json = await res.json();
    return { ok: true, latencyMs, status: res.status, models: parseModels(provider.kind, json) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, status: 0, error: String((err && err.message) || err) };
  }
}

function chatChain(cfg) {
  const chain = [];
  // Local-first routing is opt-in: a local model is tried before the paid
  // provider, then the normal primary/backup chain catches a local outage. The
  // local endpoint gets no key, so a cloud credential can never travel to it.
  if (cfg.preferLocal && cfg.localBaseUrl) {
    chain.push(descriptor({
      kind: 'auto',
      baseUrl: cfg.localBaseUrl,
      apiKey: '',
      model: cfg.localChatModel || cfg.chatModel,
      label: 'local',
    }));
  }
  chain.push(descriptor({
    kind: cfg.chatProvider,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.chatModel,
    label: 'primary',
  }));
  if (cfg.fallbackBaseUrl && cfg.fallbackApiKey) {
    chain.push(descriptor({
      kind: cfg.fallbackProvider,
      baseUrl: cfg.fallbackBaseUrl,
      apiKey: cfg.fallbackApiKey,
      model: cfg.fallbackChatModel || cfg.chatModel,
      label: 'backup',
    }));
  }
  return chain;
}

function audioDescriptor(cfg, purpose) {
  const isTts = purpose === 'tts';
  const baseUrl = isTts ? cfg.ttsBaseUrl || cfg.baseUrl : cfg.transcribeBaseUrl || cfg.baseUrl;
  const kind = normalizeKind(isTts ? cfg.ttsProvider : cfg.transcribeProvider, baseUrl);
  const explicitKey = isTts ? cfg.ttsApiKey : cfg.transcribeApiKey;
  // A cloud key is not a local server credential. Keep the fallback for remote
  // providers, but a local audio endpoint gets only the key entered for it.
  const apiKey = explicitKey || (isLocalKind(kind) ? '' : cfg.apiKey);
  const model = isTts
    ? cfg.ttsModel || 'tts-1'
    : cfg.transcribeModel || cfg.chatModel || 'whisper-1';
  return descriptor({ kind, baseUrl, apiKey, model, label: purpose });
}

module.exports = {
  PROVIDER_KINDS,
  PROVIDER_CHOICES,
  LOCAL_KINDS,
  DEFAULT_BASE_URL,
  PRICING,
  inferKind,
  normalizeKind,
  isLocalKind,
  isLoopbackHost,
  normalizeBaseUrl,
  descriptor,
  authHeaders,
  toAnthropicMessages,
  chatRequest,
  modelsRequest,
  supportsEmbeddings,
  embeddingRequest,
  parseEmbeddings,
  parseModels,
  parseStreamData,
  parseResponse,
  normalizeUsage,
  mergeUsage,
  pricingFor,
  parsePricingOverrides,
  estimateCostUsd,
  healthCheck,
  chatChain,
  audioDescriptor,
};
