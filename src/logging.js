// Structured log formatting with secret redaction.
//
// Logs are a data-exfiltration surface: a provider error can echo an
// Authorization header, and a crash dump can contain a whole config object. This
// module is pure so the redaction rules can be tested without starting Electron.
'use strict';

const SECRET_KEY = /^(api[-_]?key|apikey|authorization|x-api-key|access[-_]?token|refresh[-_]?token|secret|password|passwd|credential)$/i;

const STRING_RULES = [
  // Bearer tokens, including the "Bearer undefined" case that used to ship.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  // OpenAI / Anthropic style keys.
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]'],
  // key=value and "key": "value" forms.
  [/\b(api[-_]?key|access[-_]?token|refresh[-_]?token|x-api-key|secret|password)\b(\s*[:=]\s*)(["']?)[^"'\s,}]+/gi,
    (_m, key, sep, quote) => `${key}${sep}${quote}[redacted]`],
  // Query-string credentials.
  [/([?&](?:api[-_]?key|key|token)=)[^&\s]+/gi, '$1[redacted]'],
  // Screenshot payloads are never useful in a log line.
  [/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:image/[redacted]'],
];

function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
  return out;
}

function redactValue(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redactValue(val, depth + 1);
    }
    return out;
  }
  return value;
}

function formatLogLine(level, event, fields = {}) {
  return JSON.stringify({
    level: String(level || 'info'),
    event: String(event || 'event'),
    ...redactValue(fields),
  });
}

module.exports = { redactSecrets, redactValue, formatLogLine, SECRET_KEY };
