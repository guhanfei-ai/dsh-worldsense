// lib/util.js — Provider-agnostic pure helpers: bounded IO, text sanitization,
// timestamps and small validators. Nothing here knows about a specific source
// type; config.js, http.js and observation.js compose these primitives.
import { TRUNCATION_MARK } from './constants.js'

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function byteLength(value) {
  return new TextEncoder().encode(String(value ?? '')).byteLength
}

export function nowIso() {
  return new Date().toISOString()
}

// Parse an agent-supplied timestamp (history before/after) into a normalized
// ISO string. Rejects anything Date cannot parse, so it never reaches SQL.
export function parseIsoTimestamp(value, field) {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error(`${field} must be an ISO-8601 timestamp.`)
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be an ISO-8601 timestamp (got ${JSON.stringify(oneLine(raw, 60))}).`)
  }
  return date.toISOString()
}

// Combine the host's abort signal with a per-request timeout.
export function combineSignals(parentSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal
}

export async function abortableDelay(ms, signal) {
  const reasonOf = (s) => (s?.reason instanceof Error ? s.reason : new Error(String(s?.reason ?? 'aborted')))
  if (signal?.aborted) throw reasonOf(signal)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(reasonOf(signal))
    }, { once: true })
  })
}

// Read a response body with a hard byte ceiling enforced *while streaming*, so a
// multi-gigabyte answer is abandoned as soon as it crosses the limit instead of
// being buffered. Honors an advertised content-length as an early reject too.
// Oversize failures throw an Error carrying .responseTooLarge = observed bytes.
export async function readLimitedText(response, maxBytes) {
  const oversize = (observed) => {
    const error = new Error(`response exceeds the ${maxBytes}-byte limit`)
    error.responseTooLarge = observed
    return error
  }
  const contentLength = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    try { await response.body?.cancel?.() } catch { /* releasing is best-effort */ }
    throw oversize(contentLength)
  }

  if (!response.body?.getReader) {
    const text = await response.text()
    if (byteLength(text) > maxBytes) throw oversize(byteLength(text))
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw oversize(total)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

// Collapse newlines/tabs and truncate — used for every value that gets embedded
// into a single output line, so untrusted content can never forge extra rows.
export function oneLine(value, maxLength) {
  const s = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  return typeof maxLength === 'number' ? s.slice(0, maxLength) : s
}

// Truncate a possibly-huge string with an explicit ellipsis marker; callers set
// a truncation flag/reason on the envelope when this fires.
export function truncate(value, maxLength) {
  const s = String(value ?? '')
  if (s.length <= maxLength) return s
  return `${s.slice(0, Math.max(0, maxLength))}${TRUNCATION_MARK}`
}

// Reject out-of-range integers (error) rather than clamping, for values where
// an agent over-ask must be a visible mistake (limits the agent can raise).
export function requireBoundedInteger(value, field, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}.`)
  }
  return value
}

// Clamp instead of reject, for limits where over-asking should degrade safely.
export function clampInteger(value, min, max, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export function textOut(value) {
  return [{ type: 'text', text: String(value) }]
}

// Snapshot ids: time-sortable prefix + random suffix; no crypto requirement
// beyond uniqueness, the content identity is the content hash.
export function generateSnapshotId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  return `snap-${now.toString(36)}-${rand}`
}
