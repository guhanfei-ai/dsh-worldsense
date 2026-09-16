// test/support.mjs — Shared test scaffolding (NOT a *.test.js file, so the Node
// test runner does not execute it as a suite). Everything is deterministic and
// offline: no network, no Docker, no real credentials. Fetch is mocked at the
// globalThis boundary; the DSH credential store is a plain map; the SQLite
// store runs in a throwaway temp directory.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── HTTP responses ───────────────────────────────────────────────────────────
export function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function textResponse(text, status = 200, headers = {}) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

export function redirectResponse(location, status = 302) {
  return new Response('', { status, headers: { location } })
}

// A tool execution context: only `signal` is used by the tools.
export function execution() {
  return { signal: new AbortController().signal }
}

// ── Fetch mock ───────────────────────────────────────────────────────────────
// Replaces globalThis.fetch with a recorder. `handler(url, init, index)` returns
// a Response, an Error to throw, or a string treated as a JSON body.
export function installFetch(handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: String(init.method ?? 'GET').toUpperCase(),
      headers: init.headers ?? {},
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    }
    calls.push(call)
    let result = typeof handler === 'function' ? await handler(call.url, init, calls.length - 1) : handler
    if (typeof result === 'string') result = jsonResponse(JSON.parse(result))
    if (result instanceof Error) throw result
    return result
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

// ── Mock plugin ctx for apply() ──────────────────────────────────────────────
// credentials is a plain map ref -> secret value. The settings service is absent
// (inject is a no-op), so apply() uses the entry config it was handed — the same
// fallback path a host without the settings service would take.
export function createPluginContext({ credentials = {} } = {}) {
  const tools = []
  const sections = []
  const resolved = []
  const disposers = []
  const ctx = {
    credentials: {
      async resolve(ref) {
        resolved.push(ref)
        return Object.prototype.hasOwnProperty.call(credentials, ref) ? { value: credentials[ref] } : undefined
      },
    },
    inject() {}, // no settings service -> entry-config fallback
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    systemPrompt: { section(section) { sections.push(section) } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
  }
  return { ctx, tools, sections, resolvedRefs: resolved, disposers }
}

export function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}; registered: ${tools.map((t) => t.name).join(', ')}`)
  return tool
}

// ── Throwaway DSH_HOME so the SQLite store never touches the real ~/.dsh ─────
export function withTempDshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'worldsense-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    dir,
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// ── Standard fixtures ────────────────────────────────────────────────────────

// The payment-api style payload the demo server (and many tests) serve.
export function paymentApiBody({ version = '1.4.2', healthy = true, desired = 10, ready = 10 } = {}) {
  return {
    service: 'payment-api',
    version,
    healthy,
    replicas: { desired, ready },
  }
}

// A standard one-source config: loopback http is allowed without
// allowInsecureHttp; bearer auth via the derived credential ref.
export function demoSourceConfig(overrides = {}) {
  return {
    sources: [
      {
        id: 'prod-platform',
        name: 'Production Platform',
        description: 'Payment platform status API',
        type: 'http-json',
        baseUrl: 'http://127.0.0.1:8919',
        auth: { type: 'bearer', credential: 'PAYMENT_TOKEN' },
        timeoutMs: 2000,
        maxResponseBytes: 65536,
        endpoints: {
          'deployment-status': {
            description: 'Current deployment state of payment-api',
            path: '/api/status',
            query: {
              environment: { type: 'enum', values: ['prod', 'staging'], required: true },
              verbose: { type: 'boolean', default: false },
              limit: { type: 'integer', min: 1, max: 100, default: 20 },
            },
            fields: {
              service: '/service',
              version: '/version',
              healthy: '/healthy',
              desiredReplicas: '/replicas/desired',
              readyReplicas: '/replicas/ready',
            },
          },
          release: {
            path: '/api/release',
            fields: { releaseVersion: '/version' },
          },
        },
        ...overrides,
      },
    ],
  }
}

export function demoCredentials() {
  return { PAYMENT_TOKEN: 'payment-secret-token-abc123' }
}

// The WorldSenseError code of a thrown error, or null.
export function errorCode(error) {
  return error instanceof Error && typeof error.code === 'string' ? error.code : null
}

export async function assertThrowsCode(code, fn) {
  let caught = null
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `expected an error with code ${code}, nothing was thrown`)
  assert.equal(errorCode(caught), code, `expected code ${code}, got ${errorCode(caught)}: ${caught.message}`)
  return caught
}
