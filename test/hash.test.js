// test/hash.test.js — Deterministic content hashing (spec §54): same sanitized
// data → same hash; different key insertion order → same hash; any value
// change → different hash; unicode round-trips.
import assert from 'node:assert/strict'
import test from 'node:test'

import { contentHash, stableStringify } from '../lib/hash.js'

test('stableStringify sorts object keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify({ z: { y: 2, x: 1 }, a: [3, 1, 2] }), '{"a":[3,1,2],"z":{"x":1,"y":2}}')
})

test('array order is preserved (it is data, not key order)', () => {
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]))
})

test('the same data in different insertion order hashes identically', () => {
  const a = { status: 'healthy', version: '1.4.2', queue: { depth: 3, name: 'q1' } }
  const b = { queue: { name: 'q1', depth: 3 }, version: '1.4.2', status: 'healthy' }
  assert.equal(contentHash(a), contentHash(b))
})

test('any value change changes the hash', () => {
  const base = { status: 'healthy', version: '1.4.2' }
  assert.notEqual(contentHash(base), contentHash({ ...base, version: '1.4.3' }))
  assert.notEqual(contentHash(base), contentHash({ ...base, status: 'degraded' }))
  assert.notEqual(contentHash(base), contentHash({ ...base, extra: 1 }))
  assert.notEqual(contentHash(base), contentHash({ status: 'healthy' })) // removed key
})

test('type distinctions are preserved (1 vs "1", true vs "true")', () => {
  assert.notEqual(contentHash({ v: 1 }), contentHash({ v: '1' }))
  assert.notEqual(contentHash({ v: true }), contentHash({ v: 'true' }))
  assert.notEqual(contentHash({ v: null }), contentHash({ v: 0 }))
})

test('hash format is sha256-prefixed hex', () => {
  assert.match(contentHash({ a: 1 }), /^sha256:[0-9a-f]{64}$/)
})

test('non-finite numbers and cycles normalize instead of crashing', () => {
  assert.equal(stableStringify({ x: Number.NaN }), '{"x":null}')
  const cyclic = { a: 1 }
  cyclic.self = cyclic
  assert.doesNotThrow(() => stableStringify(cyclic))
})
