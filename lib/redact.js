// lib/redact.js — Best-effort, deterministic secret redaction. World APIs can
// echo credentials back (a status page printing its own Authorization header, a
// config object containing a password). Everything that reaches a tool result, a
// snapshot or a log line passes through here first.
//
// Honesty note (also in docs/SECURITY.md): this is a key-name and pattern
// heuristic, not a DLP product. It cannot detect every secret.

// Normalized sensitive key names. Comparison is case-insensitive and ignores
// separators ('api_key', 'apiKey', 'API-KEY' all normalize to 'apikey'). Kept
// deliberately narrow: broad words like 'auth' would nuke whole objects that
// merely DESCRIBE auth ({"auth":{"mode":"bearer"}}), hiding more than they leak.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'apisecret',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'credential',
  'privatekey',
])

// Sensitive substrings inside otherwise-legitimate string values: an upstream
// message like "authorized via Authorization: Bearer eyJ..." gets the token
// shape replaced, not the whole sentence.
const SENSITIVE_STRING_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._+/=-]{8,}/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|credential)\s*[=:]\s*["']?[^\s"',;&}]{4,}/gi,
  /\bsk-[A-Za-z0-9_-]{10,}/g,
]

export const REDACTED = '[REDACTED]'

function normalizeKey(key) {
  return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(normalizeKey(key))
}

// Redact credential-looking fragments inside a single string value.
export function redactString(text) {
  let out = String(text ?? '')
  for (const pattern of SENSITIVE_STRING_PATTERNS) out = out.replace(pattern, REDACTED)
  return out
}

// Deep, pure walk: any value whose key is sensitive becomes '[REDACTED]'; every
// string gets pattern redaction. Cycles are guarded (a malformed upstream
// payload cannot hang the walk). Arrays: redact each item; keys only exist on
// objects, but numbered items under a sensitive parent are handled by the caller
// replacing the whole subtree.
export function redactValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return REDACTED
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen))
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen)
  }
  return out
}

// True when any *segment* of an admin-configured JSON Pointer touches a
// sensitive key (e.g. alias "conn" → "/db/password"). Field selection replaces
// the whole value with '[REDACTED]' in that case — a mis-configured field can
// never smuggle a secret into an observation or snapshot.
export function pointerTouchesSensitiveKey(pointer, segmentTest = isSensitiveKey) {
  const value = String(pointer ?? '')
  if (!value || value === '/') return false
  return value.slice(1).split('/').some((token) => segmentTest(token.replace(/~1/g, '/').replace(/~0/g, '~')))
}
