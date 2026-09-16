// test/escape.test.js — THE security core (spec §44): the agent must not be
// able to escape the configured destination through any input — query parameter
// values, field aliases, endpoint ids, source ids, path manipulation, URL
// syntax ('//evil.com', 'https://evil.com', '../'). Every test asserts the
// mocked fetch (when it happens at all) only ever sees the configured origin,
// and that public tool schemas accept no raw URL/host/method/header concepts.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { validateConfig } from '../lib/config.js'
import { buildRequestUrl } from '../lib/http.js'
import { validateParams } from '../lib/observation.js'
import {
  createPluginContext,
  demoCredentials,
  demoSourceConfig,
  execution,
  installFetch,
  jsonResponse,
  paymentApiBody,
  toolByName,
} from './support.mjs'

const EVIL = 'evil.example.com'

function setup({ handler } = {}) {
  const fetchMock = installFetch(handler ?? (() => jsonResponse(paymentApiBody())))
  const { ctx, tools } = createPluginContext({ credentials: demoCredentials() })
  plugin.apply(ctx, demoSourceConfig())
  return { fetchMock, tools }
}

// ── Tool schema surface: no escape-hatch parameters ──────────────────────────
test('no public tool parameter can express a URL, host, port, protocol, path, method or header', () => {
  const { tools } = setup()
  const forbidden = /url|host|port|protocol|scheme|method|header|auth|credential|token|secret/i
  const allowedParams = new Set(['source', 'endpoint', 'fields', 'params', 'limit', 'before', 'after'])
  for (const tool of tools) {
    const params = Object.keys(tool.parameters?.properties ?? {})
    for (const param of params) {
      assert.ok(allowedParams.has(param), `${tool.name} exposes unexpected parameter "${param}"`)
      assert.ok(!forbidden.test(param), `${tool.name}.${param} looks like an escape hatch`)
    }
  }
})

test('tool names are worldsense_-prefixed and none is a generic HTTP client', () => {
  const { tools } = setup()
  assert.ok(!tools.some((t) => /http|request|curl|fetch|proxy|raw/i.test(t.name)), 'no generic HTTP tool')
  for (const tool of tools) assert.ok(tool.name.startsWith('worldsense_'))
})

// ── Query parameter values cannot move the destination ───────────────────────
test('hostile query parameter values stay URL-encoded query values on the configured origin', async () => {
  const { fetchMock, tools } = setup()
  const read = toolByName(tools, 'worldsense_read')
  const hostile = [
    `https://${EVIL}/x`,
    `//${EVIL}`,
    `..%2f..%2fevil`,
    `../../admin`,
    `&x=1#fragment`,
    `${'a'.repeat(300)}`,
  ]
  for (const value of hostile) {
    await assert.rejects(
      () => read.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: value } }, execution()),
      /invalid_parameter|enum/,
      `hostile value ${JSON.stringify(value.slice(0, 40))} must be rejected`,
    )
  }
  // And the valid value only ever hits the configured origin.
  await read.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: 'prod' } }, execution())
  for (const call of fetchMock.calls) {
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:8919\//, `unexpected destination ${call.url}`)
    assert.equal(new URL(call.url).host, '127.0.0.1:8919')
  }
  fetchMock.restore()
})

test('unknown query parameters are rejected outright', async () => {
  const { tools } = setup()
  const read = toolByName(tools, 'worldsense_read')
  await assert.rejects(
    () => read.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: 'prod', url: `https://${EVIL}` } }, execution()),
    /unknown parameter\(s\) "url"/,
  )
})

// ── Endpoint / source ids cannot inject path syntax ──────────────────────────
test('endpoint ids with path syntax are unknown ids, never resolved paths', async () => {
  const { fetchMock, tools } = setup()
  const read = toolByName(tools, 'worldsense_read')
  for (const endpoint of ['../other', '/api/status', `//${EVIL}`, `https://${EVIL}`, 'a b']) {
    await assert.rejects(
      () => read.execute({ source: 'prod-platform', endpoint }, execution()),
      /endpoint_not_found/,
      `endpoint id ${JSON.stringify(endpoint)} must be unknown`,
    )
  }
  assert.equal(fetchMock.calls.length, 0, 'no request may leave for hostile endpoint ids')
  fetchMock.restore()
})

test('source ids with URL syntax are unknown sources', async () => {
  const { fetchMock, tools } = setup()
  const read = toolByName(tools, 'worldsense_read')
  await assert.rejects(
    () => read.execute({ source: `https://${EVIL}`, endpoint: 'deployment-status' }, execution()),
    /source_not_found/,
  )
  assert.equal(fetchMock.calls.length, 0)
  fetchMock.restore()
})

test('field aliases cannot smuggle JSON Pointers', async () => {
  const { fetchMock, tools } = setup()
  const read = toolByName(tools, 'worldsense_read')
  await assert.rejects(
    () => read.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: 'prod' }, fields: ['/secret', '/../../x'] }, execution()),
    /invalid_parameter.*not configured/,
  )
  assert.equal(fetchMock.calls.length, 0)
  fetchMock.restore()
})

// ── Config-level destination confinement ─────────────────────────────────────
test('a configured endpoint path cannot escape the base origin', () => {
  for (const path of ['//evil.example.com/x', '/\\evil', '/%2f%2fevil.example.com', '/x?next=https://evil.example.com']) {
    assert.throws(
      () => validateConfig({ sources: [{ id: 's', baseUrl: 'https://api.example.com', endpoints: { e: { path, fields: { x: '/x' } } } }] }),
      /path/i,
      `path ${JSON.stringify(path)} must be rejected at config load`,
    )
  }
})

test('buildRequestUrl refuses anything that resolves off-origin', () => {
  const base = 'https://api.example.com'
  assert.equal(buildRequestUrl(base, '/api/status', new URLSearchParams()), 'https://api.example.com/api/status')
  assert.throws(() => buildRequestUrl('https://api.example.com', '//evil.example.com/x', new URLSearchParams()), /outside the configured origin|path/i)
})

test('validateParams encodes values as query components only', () => {
  const endpoint = {
    id: 'e',
    path: '/a',
    query: { q: { name: 'q', type: 'string', required: false, maxLength: 256 } },
    fields: [{ alias: 'x', pointer: '/x', required: false }],
  }
  const { search } = validateParams(endpoint, { q: 'https://evil.example.com/x?a=b' })
  const url = new URL(`https://api.example.com/a?${search.toString()}`)
  assert.equal(url.host, 'api.example.com')
  assert.equal(url.searchParams.get('q'), 'https://evil.example.com/x?a=b') // a value, not a destination
})

// ── Structural: GET only ─────────────────────────────────────────────────────
test('every request the tools make is GET with redirect:error and no body', async () => {
  const { fetchMock, tools } = setup()
  const read = toolByName(tools, 'worldsense_read')
  await read.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: 'prod' } }, execution())
  assert.ok(fetchMock.calls.length >= 1)
  for (const call of fetchMock.calls) {
    assert.equal(call.method, 'GET')
    assert.equal(call.redirect, 'error')
    assert.equal(call.body, undefined)
  }
  fetchMock.restore()
})
