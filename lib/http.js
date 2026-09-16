// lib/http.js — The only network code in WorldSense. A GET-only HTTP JSON
// client with the security envelope enforced structurally:
//
//   • GET is the only verb — REQUEST_METHOD is a constant; there is no code
//     path (config, tool argument or internal call) that can set another one,
//     and no request body is ever sent.
//   • redirect: 'error' — redirects are never followed, so an Authorization
//     header can never be forwarded to a different origin. A 3xx response
//     object (custom fetch implementations) is also refused, not followed.
//   • Every request has a timeout (combined with the host's abort signal).
//   • Every response body has a hard byte ceiling enforced while streaming.
//   • Origin confinement is re-verified per request: the resolved URL's origin
//     must equal the configured base URL's origin — belt and braces on top of
//     the path grammar validated at config load time.
import {
  REDIRECT_HINT,
  REQUEST_METHOD,
  RETRYABLE_STATUS,
  RETRY_DELAY_MS,
} from './constants.js'
import { CODES, fail, translateHttpStatus, translateNetworkFailure } from './failures.js'
import { abortableDelay, combineSignals, oneLine, readLimitedText } from './util.js'

// Build the request URL for one endpoint: base + validated path + whitelisted
// query parameters (URLSearchParams encodes values; no raw query string ever
// enters from outside). Throws if anything about the resolution changed the
// origin — the request simply never happens in that case.
export function buildRequestUrl(baseUrl, path, query) {
  const base = new URL(baseUrl)
  const url = new URL(path, base)
  if (url.origin !== base.origin) {
    throw fail(CODES.CONFIGURATION_INVALID, `endpoint path ${JSON.stringify(oneLine(path, 120))} resolved outside the configured origin; refusing to request it.`)
  }
  if (url.username || url.password) {
    throw fail(CODES.CONFIGURATION_INVALID, 'resolved request URL carries embedded credentials; refusing to request it.')
  }
  if (query && typeof query.forEach === 'function' && [...query.keys()].length > 0) {
    url.search = query.toString()
  }
  return url.toString()
}

// Perform one GET round-trip. Returns
//   { status, ok, latencyMs, text, bytes } — JSON parsing is the caller's job
// so worldsense_status can distinguish "reachable but not JSON" from "unreachable".
// Throws WorldSenseError on: network failure, timeout, redirect, oversize body.
async function performGet({ url, headers, timeoutMs, maxResponseBytes, signal, sourceId, endpointId, attemptLabel }) {
  const startedAt = Date.now()
  let response
  const requestSignal = combineSignals(signal, timeoutMs)
  try {
    response = await fetch(url, {
      method: REQUEST_METHOD,
      headers,
      redirect: 'error', // never follow redirects; never forward creds cross-origin
      signal: requestSignal,
      // no body: GET only, by construction
    })
  } catch (error) {
    const aborted = requestSignal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    if (aborted) {
      throw fail(CODES.REQUEST_TIMEOUT, `request_timeout: GET on ${where(sourceId, endpointId)} did not complete within ${timeoutMs}ms${attemptLabel}. The API may be slow or unreachable.`)
    }
    // Combine message + cause into one bounded detail so classification (DNS,
    // refused, TLS) sees the real reason undici hides in `cause`; the raw
    // exception itself is never forwarded.
    const detail = new Error(`${error?.message ?? ''} ${error?.cause?.message ?? ''}`.trim() || 'network error')
    if (detail.message.toLowerCase().includes('redirect')) {
      throw fail(CODES.REDIRECT_DENIED, `redirect_denied: ${REDIRECT_HINT} (${where(sourceId, endpointId)})`)
    }
    throw translateNetworkFailure({ error: detail, sourceId, endpointId, timeoutMs })
  }

  // Custom fetch implementations may hand us the 3xx response instead of
  // rejecting; treat it as a redirect, never follow it.
  if (response != null && Number.isFinite(response.status) && response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel?.() } catch { /* releasing is best-effort */ }
    throw fail(CODES.REDIRECT_DENIED, `redirect_denied: ${where(sourceId, endpointId)} answered HTTP ${response.status}; redirects are never followed. ${REDIRECT_HINT}`)
  }

  let text
  try {
    text = await readLimitedText(response, maxResponseBytes)
  } catch (error) {
    const aborted = requestSignal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError'
    if (aborted) {
      throw fail(CODES.REQUEST_TIMEOUT, `request_timeout: reading the response from ${where(sourceId, endpointId)} exceeded ${timeoutMs}ms.`)
    }
    if (error?.responseTooLarge !== undefined) {
      throw fail(CODES.RESPONSE_TOO_LARGE, `response_too_large: ${where(sourceId, endpointId)} returned at least ${error.responseTooLarge} bytes; the configured limit is ${maxResponseBytes} bytes. Ask the administrator to narrow the endpoint or raise maxResponseBytes (hard ceiling applies).`)
    }
    throw translateNetworkFailure({ error, sourceId, endpointId })
  }

  return {
    status: response.status,
    ok: response.ok,
    latencyMs: Date.now() - startedAt,
    text,
    bytes: new TextEncoder().encode(text).byteLength,
  }
}

// GET + parse JSON. One transparent retry on transient upstream statuses
// (idempotent GET). Throws WorldSenseError on every failure mode.
export async function fetchJson({ url, headers = {}, timeoutMs, maxResponseBytes, signal, sourceId = '', endpointId = '' }) {
  let response
  for (let attempt = 0; ; attempt += 1) {
    const attemptLabel = attempt > 0 ? ' (retry)' : ''
    response = await performGet({ url, headers, timeoutMs, maxResponseBytes, signal, sourceId, endpointId, attemptLabel })
    if (response.ok) break
    if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
      await abortableDelay(RETRY_DELAY_MS, signal)
      continue
    }
    throw translateHttpStatus({ status: response.status, url, body: response.text, sourceId, endpointId })
  }
  if (!response.text) {
    throw fail(CODES.INVALID_JSON, `invalid_json: ${where(sourceId, endpointId)} returned an empty body; a JSON document was expected.`)
  }
  try {
    return { json: JSON.parse(response.text), status: response.status, latencyMs: response.latencyMs, bytesReceived: response.bytes }
  } catch {
    // A 200 with a non-JSON body is usually a login gateway or HTML error page
    // intercepting the API path. Never treat it as success, never dump the page.
    throw fail(CODES.INVALID_JSON, `invalid_json: ${where(sourceId, endpointId)} returned HTTP ${response.status} with a non-JSON body (${oneLine(response.text, 120) || 'empty'}). If this API sits behind a login gateway or proxy, check that the endpoint path reaches the real API.`)
  }
}

// Probe for worldsense_status: same envelope, but HTTP and network failures come
// back as data ({ error }) instead of throwing, so status can report
// reachable=false with a reason instead of erroring out.
export async function probeJson({ url, headers = {}, timeoutMs, maxResponseBytes, signal, sourceId = '', endpointId = '' }) {
  try {
    const response = await performGet({ url, headers, timeoutMs, maxResponseBytes, signal, sourceId, endpointId, attemptLabel: '' })
    if (!response.ok) {
      return {
        reachable: true,
        healthy: false,
        httpStatus: response.status,
        latencyMs: response.latencyMs,
        bytesReceived: response.bytes,
        error: translateHttpStatus({ status: response.status, url, body: response.text, sourceId, endpointId }),
      }
    }
    let jsonOk = true
    let parseError = null
    try {
      JSON.parse(response.text)
    } catch {
      jsonOk = false
      parseError = fail(CODES.INVALID_JSON, `invalid_json: endpoint returned HTTP ${response.status} with a non-JSON body.`)
    }
    return {
      reachable: true,
      healthy: jsonOk,
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      bytesReceived: response.bytes,
      error: parseError,
    }
  } catch (error) {
    return {
      reachable: false,
      healthy: false,
      httpStatus: null,
      latencyMs: null,
      bytesReceived: 0,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

function where(sourceId, endpointId) {
  const src = oneLine(sourceId, 80)
  const ep = oneLine(endpointId, 80)
  if (src && ep) return `source ${JSON.stringify(src)} endpoint ${JSON.stringify(ep)}`
  return 'the configured source'
}
