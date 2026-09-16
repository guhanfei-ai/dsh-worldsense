// test/diff.test.js — Deterministic structural JSON diff (spec §55): the exact
// example case, array-by-index behavior, identical-content short-circuit, and
// the diff bounds (§56): max entries with an honest truncation flag.
import assert from 'node:assert/strict'
import test from 'node:test'

import { diffJson } from '../lib/diff.js'

function pathsOf(entries) {
  return entries.map((entry) => entry.path)
}

// ── The spec example (§55) ────────────────────────────────────────────────────
test('the reference case: changed version+replicas, added region, healthy untouched', () => {
  const before = { version: '1.0', healthy: true, replicas: 5 }
  const after = { version: '1.1', healthy: true, replicas: 8, region: 'tokyo' }
  const result = diffJson(before, after)
  assert.deepEqual(pathsOf(result.changed).sort(), ['/replicas', '/version'])
  assert.deepEqual(pathsOf(result.added), ['/region'])
  assert.deepEqual(result.removed, [])
  assert.equal(result.truncated, false)
  const versionEntry = result.changed.find((entry) => entry.path === '/version')
  assert.equal(versionEntry.before, '"1.0"')
  assert.equal(versionEntry.after, '"1.1"')
  const replicasEntry = result.changed.find((entry) => entry.path === '/replicas')
  assert.equal(replicasEntry.before, '5')
  assert.equal(replicasEntry.after, '8')
})

test('removed keys and nested changes land in the right buckets', () => {
  const before = { a: 1, deep: { x: 1, y: 2 }, gone: 'yes' }
  const after = { a: 1, deep: { x: 2, y: 2 } }
  const result = diffJson(before, after)
  assert.deepEqual(pathsOf(result.changed), ['/deep/x'])
  assert.deepEqual(result.removed, [{ path: '/gone', before: '"yes"' }])
  assert.deepEqual(result.added, [])
})

// ── Arrays compare by index (v0.1) ───────────────────────────────────────────
test('arrays diff by index with extras as added/removed items', () => {
  const result = diffJson({ items: [1, 2, 3] }, { items: [1, 9, 3, 4] })
  assert.deepEqual(pathsOf(result.changed), ['/items/1'])
  assert.deepEqual(result.added, [{ path: '/items/3', after: '4' }])
  assert.deepEqual(result.removed, [])
})

test('type changes produce a single changed entry without recursion', () => {
  const result = diffJson({ v: [1] }, { v: { 0: 1 } })
  assert.deepEqual(pathsOf(result.changed), ['/v'])
})

// ── Identical content ────────────────────────────────────────────────────────
test('identical values produce an empty diff', () => {
  const value = { a: [1, { b: 2 }], c: 'x' }
  const result = diffJson(value, structuredClone(value))
  assert.deepEqual(result.changed, [])
  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.equal(result.truncated, false)
})

// ── Determinism ──────────────────────────────────────────────────────────────
test('diff output is deterministic regardless of key insertion order', () => {
  const before1 = { a: 1, b: 2 }
  const after1 = { b: 3, a: 1 }
  const before2 = { b: 2, a: 1 }
  const after2 = { a: 1, b: 3 }
  assert.deepEqual(diffJson(before1, after1), diffJson(before2, after2))
})

// ── Bounds (§56) ─────────────────────────────────────────────────────────────
test('a huge difference is bounded to max entries with truncation disclosed', () => {
  const before = {}
  const after = {}
  for (let i = 0; i < 5000; i += 1) before[`k${i}`] = i
  for (let i = 0; i < 5000; i += 1) after[`k${i}`] = i + 1
  const result = diffJson(before, after)
  const total = result.changed.length + result.added.length + result.removed.length
  assert.equal(total, 200)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.truncationReasons, ['diff_entry_limit'])
})

test('long diff values are length-bounded', () => {
  const result = diffJson({ v: 'x' }, { v: 'y'.repeat(5000) })
  const entry = result.changed[0]
  assert.ok(entry.after.length <= 200 + 40, `value render must be bounded, got ${entry.after.length}`)
  assert.match(entry.after, /truncated/)
})
