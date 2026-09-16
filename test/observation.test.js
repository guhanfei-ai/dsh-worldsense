// test/observation.test.js — The perception pipeline: field selection via JSON
// Pointer (spec §50), graceful missing fields (§51), parameter validation,
// value bounding and honest truncation semantics (§25, §49).
import assert from 'node:assert/strict'
import test from 'node:test'

import { CODES } from '../lib/failures.js'
import { contentHash, stableStringify } from '../lib/hash.js'
import { boundValue, observe, resolveFieldSelection, validateParams } from '../lib/observation.js'
import { assertThrowsCode, installFetch, jsonResponse, paymentApiBody } from './support.mjs'

// A minimal runtime double: credentials in a map, headers like runtime.js.
function fakeRuntime(credentials = {}) {
  return {
    async buildHeaders(source) {
      const token = credentials[source.auth.credentialRef] ?? ''
      return { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
    },
  }
}

const CFG = {
  sources: [{
    id: 'prod',
    type: 'http-json',
    baseUrl: 'https://api.example.com',
    timeoutMs: 1000,
    maxResponseBytes: 65536,
    endpoints: {
      status: {
        path: '/api/status',
        query: { environment: { name: 'environment', type: 'enum', values: ['prod', 'staging'], required: true } },
        fields: {
          service: '/service',
          version: '/version',
          healthy: '/healthy',
          queueDepth: '/queue/depth',
          region: '/metadata/region',
        },
      },
    },
  }],
}

async function runObservation({ handler, credentials, ...args } = {}) {
  const fetchMock = installFetch(handler ?? (() => jsonResponse(paymentApiBody())))
  try {
    const observation = await observe(fakeRuntime(credentials), CFG, { sourceArg: 'prod', endpointArg: 'status', ...args })
    return { observation, fetchMock }
  } finally {
    fetchMock.restore()
  }
}

// ── Field selection (§50) ────────────────────────────────────────────────────
test('admin-aliased JSON Pointer selection maps to a clean data object', async () => {
  const { observation } = await runObservation({
    handler: () => jsonResponse({ service: 'payment-api', version: '1.2.3', healthy: true, queue: { depth: 7 }, metadata: { region: 'eu-1' } }),
    paramsArg: { environment: 'prod' },
  })
  assert.deepEqual(observation.data, {
    service: 'payment-api',
    version: '1.2.3',
    healthy: true,
    queueDepth: 7,
    region: 'eu-1',
  })
})

test('the agent may select a subset of admin aliases', async () => {
  const { observation } = await runObservation({
    handler: () => jsonResponse({ service: 'payment-api', version: '1.4.2', healthy: true, queue: { depth: 42 }, metadata: { region: 'eu-1' } }),
    paramsArg: { environment: 'staging' },
    fieldsArg: ['version', 'queueDepth'],
  })
  assert.deepEqual(observation.data, { version: '1.4.2', queueDepth: 42 })
})

test('unknown aliases are rejected with the valid list', async () => {
  await assertThrowsCode(CODES.INVALID_PARAMETER, () => runObservation({
    paramsArg: { environment: 'prod' },
    fieldsArg: ['version', '/etc/passwd'],
  }))
})

// ── Missing fields degrade gracefully (§51) ─────────────────────────────────
test('a missing optional field becomes a warning, not a failure', async () => {
  const { observation } = await runObservation({
    handler: () => jsonResponse({ service: 'payment-api', version: '1.0.0' }), // no healthy/queue/metadata
    paramsArg: { environment: 'prod' },
  })
  assert.deepEqual(observation.data, { service: 'payment-api', version: '1.0.0' })
  assert.deepEqual(observation.warnings.sort(), ['field_not_found:healthy', 'field_not_found:queueDepth', 'field_not_found:region'].sort())
  assert.equal(observation.truncated, false)
})

test('a missing required field (explicitly configured) fails the observation', async () => {
  const cfg = structuredClone(CFG)
  cfg.sources[0].endpoints.status.fields = { version: { pointer: '/version', required: true } }
  const fetchMock = installFetch(() => jsonResponse({ service: 'x' }))
  try {
    await assert.rejects(
      () => observe(fakeRuntime(), cfg, { sourceArg: 'prod', endpointArg: 'status', paramsArg: { environment: 'prod' } }),
      (error) => error.code === CODES.FIELD_NOT_FOUND && /required field "version"/.test(error.message),
    )
  } finally {
    fetchMock.restore()
  }
})

// ── Parameters ───────────────────────────────────────────────────────────────
test('required params must be present; defaults are applied for optional ones', () => {
  const endpoint = CFG.sources[0].endpoints.status
  assert.throws(() => validateParams(endpoint, {}), /parameter "environment" is required/)
  const { applied } = validateParams(endpoint, { environment: 'prod' })
  assert.deepEqual(applied, { environment: 'prod' })
})

test('type, range and enum validation reject bad values', () => {
  const endpoint = {
    id: 'e',
    path: '/a',
    query: {
      env: { name: 'env', type: 'enum', values: ['prod', 'staging'] },
      limit: { name: 'limit', type: 'integer', min: 1, max: 100, default: 20 },
      ratio: { name: 'ratio', type: 'number', min: 0, max: 1 },
      verbose: { name: 'verbose', type: 'boolean' },
      note: { name: 'note', type: 'string', maxLength: 16 },
    },
    fields: [{ alias: 'x', pointer: '/x', required: false }],
  }
  const bad = [
    [{ env: 'prod', limit: 0 }, /"limit" must be/],
    [{ env: 'prod', limit: 101 }, /"limit" must be/],
    [{ env: 'prod', limit: 1.5 }, /"limit" must be an integer/],
    [{ env: 'prod', ratio: 2 }, /"ratio" must be/],
    [{ env: 'dev' }, /"env" must be one of/],
    [{ env: 'prod', verbose: 'yes' }, /"verbose" must be a boolean/],
    [{ env: 'prod', note: 'x'.repeat(17) }, /"note" must not exceed/],
    [{ env: 'prod', bogus: 1 }, /unknown parameter\(s\) "bogus"/],
  ]
  for (const [params, pattern] of bad) {
    assert.throws(() => validateParams(endpoint, params), pattern, JSON.stringify(params))
  }
  const { applied } = validateParams(endpoint, { env: 'staging', limit: 55 })
  assert.deepEqual(applied, { env: 'staging', limit: 55 })
})

// ── Value bounding (§49) ─────────────────────────────────────────────────────
test('oversized strings are pruned with an honest truncation flag', async () => {
  const { observation } = await runObservation({
    handler: () => jsonResponse({ service: 's'.repeat(10_000), version: '1.0.0', healthy: true, queue: { depth: 1 }, metadata: { region: 'r' } }),
    paramsArg: { environment: 'prod' },
    fieldsArg: ['service'],
  })
  assert.ok(observation.data.service.length < 5000)
  assert.match(observation.data.service, /\[worldsense: truncated\]$/)
  assert.equal(observation.truncated, true)
  assert.deepEqual(observation.truncationReasons, ['field_value_limit'])
})

test('deeply nested values are depth-pruned, huge arrays item-pruned', () => {
  let deep = { v: 1 }
  for (let i = 0; i < 60; i += 1) deep = { child: deep }
  const deepResult = boundValue(deep)
  assert.ok(deepResult.pruned)
  assert.equal(JSON.stringify(deepResult.value).length < 2000, true)

  const arrResult = boundValue({ items: Array.from({ length: 500 }, (_, i) => i) })
  assert.ok(arrResult.pruned)
  assert.equal(arrResult.value.items.length, 101) // 100 kept + marker
  assert.match(arrResult.value.items[100], /more item/)
})

test('a small remote answer is NOT truncation (no false truncated flags)', async () => {
  const { observation } = await runObservation({
    handler: () => jsonResponse({ service: 'payment-api', version: '1.0.0', healthy: true, queue: { depth: 3 }, metadata: { region: 'r' } }),
    paramsArg: { environment: 'prod' },
  })
  assert.equal(observation.truncated, false)
  assert.deepEqual(observation.truncationReasons, [])
})

// ── Provenance & hash ────────────────────────────────────────────────────────
test('the observation carries provenance, hash and byte accounting', async () => {
  const { observation, fetchMock } = await runObservation({ paramsArg: { environment: 'prod' } })
  assert.equal(observation.provenance.method, 'GET')
  assert.equal(observation.provenance.source, 'prod')
  assert.equal(observation.provenance.endpoint, 'status')
  assert.equal(observation.provenance.url, fetchMock.calls[0].url)
  assert.equal(observation.provenance.params.environment, 'prod')
  assert.equal(observation.contentHash, contentHash(observation.data))
  assert.ok(observation.bytesReceived > 0)
  assert.match(observation.observedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('url in provenance never carries credentials', async () => {
  const { observation } = await runObservation({ credentials: { WORLDSENSE_TOKEN_prod: 'sekrit' }, paramsArg: { environment: 'prod' } })
  assert.ok(!observation.provenance.url.includes('sekrit'))
  assert.ok(!stableStringify(observation).includes('sekrit'))
})
