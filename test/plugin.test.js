// test/plugin.test.js — Host-facing metadata, apply() registration behavior,
// secure schema defaults, and the frozen internals surface.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { createPluginContext, demoSourceConfig } from './support.mjs'

const TOOL_NAMES = [
  'worldsense_sources',
  'worldsense_status',
  'worldsense_read',
  'worldsense_snapshot',
  'worldsense_history',
  'worldsense_diff',
]

const INTERNAL_KEYS = [
  'CODES',
  'WorldSenseError',
  'boundValue',
  'buildRequestUrl',
  'contentHash',
  'createRuntime',
  'createStoreHandle',
  'defaultDbPath',
  'diffJson',
  'effectiveSources',
  'getByPointer',
  'isSensitiveKey',
  'observe',
  'redactString',
  'redactValue',
  'renderObservation',
  'resolveDbPath',
  'resolveEndpoint',
  'resolveFieldSelection',
  'resolveSource',
  'stableStringify',
  'toWorldSenseError',
  'translateHttpStatus',
  'translateNetworkFailure',
  'validateConfig',
  'validateParamValue',
  'validateParams',
  'validatePointer',
]

// ── Host-facing metadata ─────────────────────────────────────────────────────
test('the plugin exports the metadata the harness consumes', () => {
  assert.equal(plugin.name, 'worldsense')
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt', 'credentials'])
  assert.equal(plugin.SETTINGS_NAMESPACE, 'worldsense')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})

// ── apply(): registration + system prompt ────────────────────────────────────
test('apply registers exactly the six worldsense_* tools in a stable order', () => {
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, demoSourceConfig())
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES)
})

test('apply registers a single read-only guidance section for the system prompt', () => {
  const { ctx, sections } = createPluginContext({})
  plugin.apply(ctx, demoSourceConfig())
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:worldsense')
  assert.equal(typeof sections[0].order, 'number')
  assert.match(sections[0].text, /READ-ONLY/)
  assert.match(sections[0].text, /UNTRUSTED DATA/)
  assert.match(sections[0].text, /worldsense_diff/)
  assert.match(sections[0].text, /never/i)
})

test('every registered tool declares an output schema, render, timeout and call card', () => {
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, demoSourceConfig())
  // Valid args per tool: presentCall returns undefined when args fail the
  // parameter schema (the registry hides the card for invalid calls).
  const validArgs = {
    worldsense_sources: {},
    worldsense_status: { source: 'prod-platform' },
    worldsense_read: { source: 'prod-platform', endpoint: 'deployment-status' },
    worldsense_snapshot: { source: 'prod-platform', endpoint: 'deployment-status' },
    worldsense_history: {},
    worldsense_diff: { before: 'snap-x', after: 'snap-y' },
  }
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', `${tool.name}.execute`)
    assert.ok(tool.output?.schema, `${tool.name}.output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name}.output.render`)
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `${tool.name}.timeoutMs`)
    assert.equal(typeof tool.presentCall, 'function', `${tool.name}.presentCall`)
    const card = tool.presentCall(validArgs[tool.name])
    assert.equal(card?.card, 'generic', `${tool.name} card`)
    assert.equal(card?.kind, 'read')
    assert.ok(typeof card?.title === 'string' && card.title.length > 0)
  }
})

// ── apply() validates config before wiring anything ──────────────────────────
test('apply rejects an invalid config and registers nothing', () => {
  const dupSource = (host) => ({ id: 'dup', baseUrl: `https://${host}`, endpoints: { e: { path: '/a', fields: { f: '/f' } } } })
  for (const bad of [
    { sources: [{ id: 'x', baseUrl: 'https://a.example.com', password: 'hunter2' }] },
    { sources: [{ id: 'x', baseUrl: 'https://a.example.com', endpoints: {} }] },
    { sources: [{ id: 'x', baseUrl: 'not a url', endpoints: { e: { path: '/a', fields: { f: '/f' } } } }] },
    { sources: [dupSource('a.example.com'), dupSource('b.example.com')] },
  ]) {
    const { ctx, tools, sections } = createPluginContext({})
    assert.throws(() => plugin.apply(ctx, bad), /worldsense|Source|source|endpoint|baseUrl|password|literal/i)
    assert.equal(tools.length, 0)
    assert.equal(sections.length, 0)
  }
})

// ── Config schema: secure defaults ───────────────────────────────────────────
test('the Config schema defaults to no sources and insecure HTTP off', () => {
  const resolved = plugin.Config({})
  assert.deepEqual(resolved.sources, [])
  assert.equal(resolved.allowInsecureHttp, false) // secure by default
  assert.equal(resolved.dbPath, '')
})

test('the Config schema preserves valid operator input', () => {
  const resolved = plugin.Config({ sources: [{ id: 'prod', baseUrl: 'https://api.example.com', endpoints: { e: { path: '/a', fields: { f: '/f' } } } }], allowInsecureHttp: false })
  assert.equal(resolved.sources[0].id, 'prod')
})

// ── internals: a frozen surface for host introspection/tests ─────────────────
test('internals is frozen and exposes every security-critical primitive', () => {
  assert.equal(Object.isFrozen(plugin.internals), true)
  assert.deepEqual(Object.keys(plugin.internals).sort(), [...INTERNAL_KEYS].sort())
  for (const key of INTERNAL_KEYS) {
    assert.ok(plugin.internals[key] !== undefined, `internals.${key} must exist`)
  }
})
