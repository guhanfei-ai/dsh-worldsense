// lib/failures.js — The error model. Every failure surfaces as a WorldSenseError
// carrying a stable machine code plus a short, actionable, secret-free message.
// Upstream bodies are untrusted and may echo credentials, so every fragment
// drawn from them is redacted, single-lined and truncated before it reaches an
// agent-facing string. Raw fetch/undici exception dumps are never forwarded.
import { ERROR_DETAIL_MAX_CHARS } from './constants.js'
import { redactString } from './redact.js'
import { oneLine } from './util.js'

export const CODES = Object.freeze({
  CONFIGURATION_INVALID: 'configuration_invalid',
  SOURCE_NOT_FOUND: 'source_not_found',
  ENDPOINT_NOT_FOUND: 'endpoint_not_found',
  INVALID_PARAMETER: 'invalid_parameter',
  FIELD_NOT_FOUND: 'field_not_found',
  CREDENTIAL_UNAVAILABLE: 'credential_unavailable',
  REQUEST_TIMEOUT: 'request_timeout',
  CONNECTION_FAILED: 'connection_failed',
  REDIRECT_DENIED: 'redirect_denied',
  RESPONSE_TOO_LARGE: 'response_too_large',
  INVALID_JSON: 'invalid_json',
  HTTP_ERROR: 'http_error',
  SNAPSHOT_NOT_FOUND: 'snapshot_not_found',
})

export class WorldSenseError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'WorldSenseError'
    this.code = code
  }
}

export function fail(code, message) {
  return new WorldSenseError(code, message)
}

// Wrap an arbitrary thrown value (config error, validation error, bug) into a
// bounded, redacted WorldSenseError, preserving the code when it already is one.
export function toWorldSenseError(error, fallbackCode = CODES.INVALID_PARAMETER) {
  if (error instanceof WorldSenseError) return error
  const message = oneLine(redactString(error instanceof Error ? error.message : String(error ?? '')), ERROR_DETAIL_MAX_CHARS) || 'unknown error'
  return new WorldSenseError(fallbackCode, message)
}

// Bounded detail extraction from an upstream JSON error body.
function safeErrorDetail(text) {
  const raw = String(text ?? '')
  try {
    const parsed = JSON.parse(raw)
    const err = parsed?.error
    if (err && typeof err === 'object') {
      const reason = typeof err.reason === 'string' ? err.reason : ''
      const message = typeof parsed?.message === 'string' ? parsed.message : ''
      const joined = [reason || message].filter(Boolean).join(': ')
      if (joined) return oneLine(redactString(joined), ERROR_DETAIL_MAX_CHARS)
    }
    if (typeof err === 'string' && err) return oneLine(redactString(err), ERROR_DETAIL_MAX_CHARS)
    if (typeof parsed?.message === 'string' && parsed.message) return oneLine(redactString(parsed.message), ERROR_DETAIL_MAX_CHARS)
  } catch {
    // not JSON — fall through to the bounded raw description
  }
  return oneLine(redactString(raw), ERROR_DETAIL_MAX_CHARS) || 'no error details'
}

// HTTP status → categorized WorldSenseError. 401/403 keep their own semantics
// (credential vs permission); everything else folds into http_error with the
// status visible.
export function translateHttpStatus({ status, url, body = '', sourceId = '', endpointId = '' }) {
  const code = Number(status)
  const where = wherePhrase(sourceId, endpointId)
  const detail = safeErrorDetail(body)
  if (code === 401) {
    return fail(CODES.HTTP_ERROR, `http 401 on ${where}: authentication failed — the credential is missing, expired or invalid. Check the credential store entry for this source. (${detail})`)
  }
  if (code === 403) {
    return fail(CODES.HTTP_ERROR, `http 403 on ${where}: permission denied — the source authenticated but is not allowed to read this endpoint. (${detail})`)
  }
  if (code === 404) {
    return fail(CODES.HTTP_ERROR, `http 404 on ${where}: the endpoint path does not exist upstream. Check the configured path. (${detail})`)
  }
  if (code === 408) {
    return fail(CODES.HTTP_ERROR, `http 408 on ${where}: the upstream API timed out. Retry, or ask the administrator to raise timeoutMs for this source.`)
  }
  if (code === 429) {
    return fail(CODES.HTTP_ERROR, `http 429 on ${where}: the upstream API is rate-limiting requests. Wait and retry.`)
  }
  if (code >= 500 && code <= 599) {
    return fail(CODES.HTTP_ERROR, `http ${code} on ${where}: upstream server error, usually transient. Retry once. (${detail})`)
  }
  return fail(CODES.HTTP_ERROR, `http ${code} on ${where}: ${detail}`)
}

// Network-level failure → categorized WorldSenseError. Never interpolates the
// raw exception verbatim (it can carry proxy diagnostics or the full URL).
export function translateNetworkFailure({ error, sourceId = '', endpointId = '', timeoutMs }) {
  const where = wherePhrase(sourceId, endpointId)
  const reason = oneLine(redactString(error?.message ?? String(error ?? '')), ERROR_DETAIL_MAX_CHARS) || 'network error'
  if (/getaddrinfo|enotfound|dns/i.test(reason)) {
    return fail(CODES.CONNECTION_FAILED, `cannot resolve the host for ${where}: check the configured baseUrl hostname. (${reason})`)
  }
  if (/econnrefused|connection refused/i.test(reason)) {
    return fail(CODES.CONNECTION_FAILED, `connection refused by ${where}: is the API running and reachable from here? (${reason})`)
  }
  if (/self.signed|unable to verify|certificate|tls|ssl|depth/i.test(reason)) {
    return fail(CODES.CONNECTION_FAILED, `TLS/certificate error talking to ${where}: the upstream certificate could not be verified. (${reason})`)
  }
  return fail(CODES.CONNECTION_FAILED, `connection to ${where} failed${timeoutMs ? ` within ${timeoutMs}ms` : ''}: ${reason}`)
}

function wherePhrase(sourceId, endpointId) {
  const src = oneLine(sourceId, 80)
  const ep = oneLine(endpointId, 80)
  if (src && ep) return `source ${JSON.stringify(src)} endpoint ${JSON.stringify(ep)}`
  if (src) return `source ${JSON.stringify(src)}`
  return 'the configured source'
}
