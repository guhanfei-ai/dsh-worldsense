// test/http.test.js — The GET-only HTTP client envelope: redirects (spec §32,
// §47), timeouts (§48), response byte budget (§49), invalid JSON, HTTP error
// translation and the single transparent retry.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CODES } from '../lib/failures.js'
import { buildRequestUrl, fetchJson, probeJson } from '../lib/http.js'
import { assertThrowsCode, jsonResponse, redirectResponse, textResponse } from './support.mjs'

const URL_OK = 'https://api.example.com/api/status'

async function call(handler, { probe = false } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const result = await handler(url, init)
    if (result instanceof Error) throw result
    return result
  }
  try {
    const request = {
      url: URL_OK,
      headers: { accept: 'application/json' },
      timeoutMs: 500,
      maxResponseBytes: 64 * 1024,
      sourceId: 's',
      endpointId: 'e',
    }
    return probe ? await probeJson(request) : await fetchJson(request)
  } finally {
    globalThis.fetch = original
  }
}

// ── Redirects are never followed (§32, §47) ──────────────────────────────────
test('a 302 response object is refused as redirect_denied, never followed', async () => {
  const seen = []
  await assertThrowsCode(CODES.REDIRECT_DENIED, () => call((url) => {
    seen.push(url)
    return redirectResponse(`https://evil.example.com/steal?token=1`)
  }))
  assert.equal(seen.length, 1, 'exactly one request — no follow-up')
})

test('a fetch rejection mentioning redirect surfaces the redirect hint', async () => {
  const cause = new Error('redirect mode is defined as "error" and the response had a redirect status')
  const error = new TypeError('fetch failed')
  error.cause = cause
  const caught = await assertThrowsCode(CODES.REDIRECT_DENIED, () => call(() => { throw error }))
  assert.match(caught.message, /redirect/i)
  assert.match(caught.message, /never forwarded|never followed/i)
})

// ── Timeout (§48) ────────────────────────────────────────────────────────────
test('a hanging upstream produces request_timeout, not a hang', async () => {
  const original = globalThis.fetch
  // A fetch that never settles on its own but honors the abort signal,
  // exactly like undici when the request times out.
  globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('This operation was aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  const startedAt = Date.now()
  try {
    await assertThrowsCode(CODES.REQUEST_TIMEOUT, () => fetchJson({
      url: URL_OK,
      headers: {},
      timeoutMs: 80,
      maxResponseBytes: 1024,
      sourceId: 's',
      endpointId: 'e',
    }))
    assert.ok(Date.now() - startedAt < 2000, 'must give up promptly')
  } finally {
    globalThis.fetch = original
  }
})

// ── Response byte budget (§49) ───────────────────────────────────────────────
test('an advertised content-length over the cap is rejected before reading', async () => {
  await assertThrowsCode(CODES.RESPONSE_TOO_LARGE, () => call(() => jsonResponse({ a: 1 }, 200, { 'content-length': String(10 * 1024 * 1024) })))
})

test('a streaming body over the cap is abandoned mid-read', async () => {
  const big = { blob: 'x'.repeat(200 * 1024) }
  await assertThrowsCode(CODES.RESPONSE_TOO_LARGE, () => call(() => jsonResponse(big)))
})

// ── JSON handling ────────────────────────────────────────────────────────────
test('a 200 with a non-JSON body is invalid_json, never success', async () => {
  await assertThrowsCode(CODES.INVALID_JSON, () => call(() => textResponse('<html>login page</html>')))
})

test('an empty 200 body is invalid_json', async () => {
  await assertThrowsCode(CODES.INVALID_JSON, () => call(() => textResponse('')))
})

test('valid JSON returns parsed payload with status and latency', async () => {
  const result = await call(() => jsonResponse({ status: 'healthy' }))
  assert.deepEqual(result.json, { status: 'healthy' })
  assert.equal(result.status, 200)
  assert.equal(typeof result.latencyMs, 'number')
})

// ── HTTP error translation ───────────────────────────────────────────────────
test('HTTP error statuses map to bounded http_error messages', async () => {
  for (const status of [400, 401, 403, 404, 408, 429, 500, 502]) {
    // 502 is retryable: first call errors, second call must also 502 to end.
    let calls = 0
    const caught = await assertThrowsCode(CODES.HTTP_ERROR, () => call(() => {
      calls += 1
      return jsonResponse({ error: { reason: `boom ${status}` } }, status)
    }))
    assert.match(caught.message, new RegExp(`http ${status}`))
    assert.ok(caught.message.length < 600, 'error message must stay bounded')
  }
})

test('upstream error details are redacted inside http_error messages', async () => {
  const caught = await assertThrowsCode(CODES.HTTP_ERROR, () => call(() =>
    jsonResponse({ error: { reason: 'invalid Authorization: Bearer super-secret-token-12345' } }, 400),
  ))
  assert.ok(!caught.message.includes('super-secret-token-12345'), 'the echoed token must be redacted')
  assert.match(caught.message, /REDACTED/)
})

// ── Retry ────────────────────────────────────────────────────────────────────
test('one transparent retry happens on 503 and succeeds', async () => {
  let calls = 0
  const result = await call(() => {
    calls += 1
    return calls === 1 ? jsonResponse({ error: 'overloaded' }, 503) : jsonResponse({ ok: true })
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.json, { ok: true })
})

// ── Network failures ─────────────────────────────────────────────────────────
test('DNS/connection failures map to connection_failed with bounded detail', async () => {
  const caught = await assertThrowsCode(CODES.CONNECTION_FAILED, () => call(() => { throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.example.com') }) }))
  assert.match(caught.message, /cannot resolve the host/)
})

// ── probeJson (worldsense_status) ────────────────────────────────────────────
test('probeJson reports HTTP failure as data instead of throwing', async () => {
  const probed = await call(() => jsonResponse({ error: 'nope' }, 500), { probe: true })
  assert.equal(probed.reachable, true)
  assert.equal(probed.healthy, false)
  assert.equal(probed.httpStatus, 500)
  assert.equal(probed.error.code, 'http_error')
})

test('probeJson reports network failure as unreachable', async () => {
  const probed = await call(() => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }) }, { probe: true })
  assert.equal(probed.reachable, false)
  assert.equal(probed.error.code, 'connection_failed')
})

test('buildRequestUrl confines the request to the base origin', () => {
  const url = buildRequestUrl('https://api.example.com', '/a/b', new URLSearchParams({ q: 'x y' }))
  assert.equal(url, 'https://api.example.com/a/b?q=x+y')
})
