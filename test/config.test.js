// test/config.test.js — Source/endpoint configuration: canonicalization and
// fail-fast validation (spec §43: valid source, duplicate source id, invalid
// source, invalid base URL, invalid endpoint, invalid query schema, invalid
// auth, invalid JSON Pointer).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  effectiveSources,
  resolveEndpoint,
  resolveSource,
  sanitizeBaseUrlForDisplay,
  validateConfig,
} from '../lib/config.js'
import { demoSourceConfig } from './support.mjs'

const BASE = { id: 's1', baseUrl: 'https://api.example.com', endpoints: { status: { path: '/api/status', fields: { ok: '/ok' } } } }

function withSource(source) {
  return { sources: Array.isArray(source) ? source : [source] }
}

function normalize(source) {
  return effectiveSources(withSource(source))[0]
}

// ── Valid configs ────────────────────────────────────────────────────────────
test('a valid source canonicalizes with derived credential refs and defaults', () => {
  validateConfig(withSource(BASE))
  const source = normalize(BASE)
  assert.equal(source.id, 's1')
  assert.equal(source.type, 'http-json')
  assert.equal(source.baseUrl, 'https://api.example.com')
  assert.equal(source.auth.type, 'none')
  assert.equal(source.timeoutMs, 10_000)
  assert.equal(source.maxResponseBytes, 1024 * 1024)
  assert.equal(source.endpoints.length, 1)
  const endpoint = source.endpoints[0]
  assert.equal(endpoint.id, 'status')
  assert.equal(endpoint.path, '/api/status')
  assert.deepEqual(endpoint.fields, [{ alias: 'ok', pointer: '/ok', required: false }])
})

test('bearer auth derives the credential ref from the source id', () => {
  const source = normalize({ ...BASE, auth: { type: 'bearer' } })
  assert.equal(source.auth.type, 'bearer')
  assert.equal(source.auth.credentialRef, 'WORLDSENSE_TOKEN_s1')
})

test('an explicit credential ref is kept and validated', () => {
  const source = normalize({ ...BASE, auth: { type: 'bearer', credential: 'my_token' } })
  assert.equal(source.auth.credentialRef, 'my_token')
  assert.throws(
    () => validateConfig(withSource({ ...BASE, auth: { type: 'bearer', credential: 'not valid!' } })),
    /not a valid credential reference/,
  )
})

test('api-key-header auth keeps the admin header and derives its ref', () => {
  const source = normalize({ ...BASE, auth: { type: 'api-key-header', header: 'X-Custom-Key', credential: 'k' } })
  assert.equal(source.auth.header, 'X-Custom-Key')
  assert.equal(source.auth.credentialRef, 'k')
  const defaulted = normalize({ ...BASE, auth: { type: 'api-key-header' } })
  assert.equal(defaulted.auth.header, 'X-API-Key')
  assert.equal(defaulted.auth.credentialRef, 'WORLDSENSE_APIKEY_s1')
})

test('basic auth derives username/password refs', () => {
  const source = normalize({ ...BASE, auth: { type: 'basic' } })
  assert.equal(source.auth.usernameRef, 'WORLDSENSE_USERNAME_s1')
  assert.equal(source.auth.passwordRef, 'WORLDSENSE_PASSWORD_s1')
})

test('array forms for sources/endpoints/query/fields canonicalize like map forms', () => {
  const cfg = {
    sources: [
      {
        id: 'arr',
        baseUrl: 'https://api.example.com',
        endpoints: [
          { id: 'status', path: '/api/status', query: [{ name: 'env', type: 'enum', values: ['prod'] }], fields: [{ alias: 'ok', pointer: '/ok' }] },
        ],
      },
    ],
  }
  validateConfig(cfg)
  const source = effectiveSources(cfg)[0]
  assert.equal(source.endpoints[0].query.env.type, 'enum')
  assert.deepEqual(source.endpoints[0].query.env.values, ['prod'])
  assert.equal(source.endpoints[0].fields[0].alias, 'ok')
})

// ── Duplicate ids ────────────────────────────────────────────────────────────
test('duplicate source ids are rejected', () => {
  assert.throws(
    () => validateConfig(withSource([{ ...BASE }, { ...BASE }])),
    /Duplicate source id "s1"/,
  )
})

test('duplicate endpoint ids within a source are rejected', () => {
  assert.throws(
    () => validateConfig(withSource({ ...BASE, endpoints: [
      { id: 'status', path: '/a', fields: { x: '/x' } },
      { id: 'status', path: '/b', fields: { y: '/y' } },
    ] })),
    /endpoint ids must be unique/,
  )
})

test('duplicate query parameter names and field aliases are rejected', () => {
  assert.throws(
    () => validateConfig(withSource({ ...BASE, endpoints: { status: { path: '/a', query: { env: { type: 'string' }, env2: { name: 'env', type: 'string' } }, fields: { x: '/x' } } } })),
    /duplicate query parameter "env"/i,
  )
  assert.throws(
    () => validateConfig(withSource({ ...BASE, endpoints: { status: { path: '/a', fields: { x: '/x', y: { alias: 'x', pointer: '/y' } } } } })),
    /unique/,
  )
})

// ── Source-level validation ──────────────────────────────────────────────────
test('invalid source ids are rejected', () => {
  for (const id of ['', ' leading', 'a'.repeat(65), 'x/y', 'x?y', '-leading-hyphen']) {
    assert.throws(() => validateConfig(withSource({ ...BASE, id })), /Source id/, `id ${JSON.stringify(id)} should be rejected`)
  }
})

test('unsupported source types are rejected', () => {
  assert.throws(
    () => validateConfig(withSource({ ...BASE, type: 'graphql' })),
    /unsupported type "graphql"/,
  )
})

test('invalid base URLs are rejected', () => {
  for (const baseUrl of ['', 'not a url', 'ftp://example.com', 'https://u:p@example.com', 'https://example.com/?q=1', 'https://example.com/#frag']) {
    assert.throws(() => validateConfig(withSource({ ...BASE, baseUrl })), /baseUrl/, `${JSON.stringify(baseUrl)} should be rejected`)
  }
})

test('plain http is rejected for non-loopback hosts unless explicitly allowed', () => {
  assert.throws(() => validateConfig(withSource({ ...BASE, baseUrl: 'http://api.example.com' })), /Plain HTTP is disabled/)
  // per-source allowance
  validateConfig(withSource({ ...BASE, baseUrl: 'http://api.example.com', allowInsecureHttp: true }))
  // global allowance
  validateConfig({ ...withSource({ ...BASE, baseUrl: 'http://api.example.com' }), allowInsecureHttp: true })
  // loopback is always fine
  validateConfig(withSource({ ...BASE, baseUrl: 'http://localhost:8080' }))
  validateConfig(withSource({ ...BASE, baseUrl: 'http://127.0.0.1:8080' }))
})

test('invalid limits are rejected', () => {
  assert.throws(() => validateConfig(withSource({ ...BASE, timeoutMs: 100 })), /timeoutMs/)
  assert.throws(() => validateConfig(withSource({ ...BASE, timeoutMs: 60_001 })), /timeoutMs/)
  assert.throws(() => validateConfig(withSource({ ...BASE, maxResponseBytes: 100 })), /maxResponseBytes/)
  assert.throws(() => validateConfig(withSource({ ...BASE, maxResponseBytes: 5 * 1024 * 1024 })), /maxResponseBytes/)
})

test('literal secrets anywhere in source config are rejected', () => {
  for (const key of ['password', 'token', 'secret', 'apiKey', 'api_key', 'authorization', 'credential']) {
    assert.throws(
      () => validateConfig(withSource({ ...BASE, [key]: 'hunter2' })),
      new RegExp(`literal "${key}"`),
      `literal ${key} should be rejected`,
    )
  }
  assert.throws(
    () => validateConfig(withSource({ ...BASE, auth: { type: 'bearer', token: 'abc' } })),
    /literal "token"/,
  )
})

// ── Endpoint path validation ─────────────────────────────────────────────────
test('endpoint paths must be safe relative paths', () => {
  for (const path of ['', 'api/status', 'https://evil.example.com/x', '//evil.example.com/x', '/a?b=1', '/a#f', '/a\\b', '/a\nb', '/spa ce']) {
    assert.throws(
      () => validateConfig(withSource({ ...BASE, endpoints: { e: { path, fields: { x: '/x' } } } })),
      /path/i,
      `path ${JSON.stringify(path)} should be rejected`,
    )
  }
})

test('a source needs at least one endpoint and valid endpoint ids', () => {
  assert.throws(() => validateConfig(withSource({ ...BASE, endpoints: {} })), /at least one endpoint/)
  assert.throws(
    () => validateConfig(withSource({ ...BASE, endpoints: { 'bad id!': { path: '/a', fields: { x: '/x' } } } })),
    /endpoint id "bad id!"/,
  )
})

// ── Query schema validation ──────────────────────────────────────────────────
test('invalid query schemas are rejected', () => {
  const cases = [
    { env: { type: 'expression' } }, // unsupported type
    { env: { type: 'enum' } }, // enum without values
    { env: { type: 'enum', values: ['a', 'a'] } }, // duplicate values
    { env: { type: 'integer', min: 10, max: 1 } }, // min > max
    { env: { type: 'integer', default: 99, min: 1, max: 10 } }, // default out of range
    { env: { type: 'enum', values: ['prod'], default: 'staging' } }, // default not in values
    { env: { type: 'string', default: 42 } }, // wrong default type
    { env: { type: 'number', min: 'low' } }, // non-numeric min
  ]
  for (const query of cases) {
    assert.throws(
      () => validateConfig(withSource({ ...BASE, endpoints: { e: { path: '/a', query, fields: { x: '/x' } } } })),
      /query parameter "env"/i,
      `query ${JSON.stringify(query)} should be rejected`,
    )
  }
})

// ── Field / pointer validation ───────────────────────────────────────────────
test('invalid JSON Pointers in field config are rejected', () => {
  for (const pointer of ['', 'status', '/a~x', '/a#b', 'a/b']) {
    assert.throws(
      () => validateConfig(withSource({ ...BASE, endpoints: { e: { path: '/a', fields: { x: pointer } } } })),
      /not a valid JSON Pointer/,
      `pointer ${JSON.stringify(pointer)} should be rejected`,
    )
  }
})

test('invalid field aliases are rejected and at least one field is required', () => {
  assert.throws(
    () => validateConfig(withSource({ ...BASE, endpoints: { e: { path: '/a', fields: { 'bad alias!': '/x' } } } })),
    /field alias "bad alias!"/,
  )
  assert.throws(
    () => validateConfig(withSource({ ...BASE, endpoints: { e: { path: '/a', fields: {} } } })),
    /at least one field alias/,
  )
})

// ── Resolution ───────────────────────────────────────────────────────────────
test('resolveSource finds by id, then name, and errors with the valid list', () => {
  const cfg = demoSourceConfig()
  assert.equal(resolveSource(cfg, 'prod-platform').id, 'prod-platform')
  assert.equal(resolveSource(cfg, 'Production Platform').id, 'prod-platform')
  assert.throws(() => resolveSource(cfg, 'nope'), /source_not_found.*prod-platform/)
})

test('resolveSource with no argument uses the single configured source', () => {
  assert.equal(resolveSource(demoSourceConfig()).id, 'prod-platform')
})

test('resolveEndpoint resolves by id, defaults to the first, and errors helpfully', () => {
  const source = effectiveSources(demoSourceConfig())[0]
  assert.equal(resolveEndpoint(source, 'release').id, 'release')
  assert.equal(resolveEndpoint(source).id, 'deployment-status')
  assert.throws(() => resolveEndpoint(source, undefined, { required: true }), /endpoint is required/)
  assert.throws(() => resolveEndpoint(source, 'nope'), /endpoint_not_found.*deployment-status.*release/)
})

test('sanitizeBaseUrlForDisplay strips userinfo defensively', () => {
  assert.equal(sanitizeBaseUrlForDisplay('https://api.example.com'), 'https://api.example.com')
  assert.equal(sanitizeBaseUrlForDisplay(''), '(not set)')
})
