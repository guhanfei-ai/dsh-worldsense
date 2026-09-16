// test/store.test.js — SQLite snapshot persistence (spec §53): create DB,
// snapshot, restart store, history, read metadata — plus schema versioning,
// parameterized writes, path resolution and concurrent writes (§58).
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SCHEMA_VERSION,
  createSnapshotStore,
  createStoreHandle,
  defaultDbPath,
  openDatabase,
  resolveDbPath,
  requireSnapshot,
} from '../lib/store.js'
import { assertThrowsCode } from './support.mjs'

let counter = 0
function freshDir() {
  counter += 1
  return mkdtempSync(join(tmpdir(), `ws-store-${counter}-`))
}

function openStore(dir) {
  return createSnapshotStore(openDatabase(join(dir, 'worldsense.db')).db)
}

function insertOne(store, { version = '1.0.0' } = {}) {
  return store.insertSnapshot({
    sourceId: 'prod-platform',
    endpointId: 'deployment-status',
    observedAt: new Date(Date.now() - Math.random() * 1000).toISOString(),
    contentHash: `sha256:${version}`,
    data: { version, healthy: true },
    metadata: { provenance: { method: 'GET' }, warnings: [], truncationReasons: [] },
  })
}

function firstValue(row) {
  return Object.values(row)[0]
}

test('openDatabase creates the file, applies WAL/busy_timeout and migrates to the current version', () => {
  const dir = freshDir()
  try {
    const file = join(dir, 'worldsense.db')
    const opened = openDatabase(file)
    assert.equal(opened.schemaVersion, SCHEMA_VERSION)
    assert.equal(opened.migrated, true)
    assert.ok(existsSync(file))
    assert.equal(String(firstValue(opened.db.prepare('PRAGMA journal_mode').get())).toLowerCase(), 'wal')
    assert.equal(Number(firstValue(opened.db.prepare('PRAGMA busy_timeout').get())), 5000)
    const version = Number(firstValue(opened.db.prepare('PRAGMA user_version').get()))
    assert.equal(version, SCHEMA_VERSION)
    // reopening an already-migrated database is a no-op
    const reopened = openDatabase(file)
    assert.equal(reopened.migrated, false)
    reopened.db.close()
    opened.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshots persist across store restarts (create → close → reopen → history)', () => {
  const dir = freshDir()
  try {
    const first = openStore(dir)
    const { id } = insertOne(first, { version: '1.0.0' })
    insertOne(first, { version: '1.1.0' })
    // "restart": a brand-new store over the same file
    const second = openStore(dir)
    const snapshot = second.getSnapshot(id)
    assert.ok(snapshot, 'snapshot survives the restart')
    assert.equal(snapshot.data.version, '1.0.0')
    assert.equal(snapshot.sourceId, 'prod-platform')
    assert.equal(snapshot.metadata.provenance.method, 'GET')
    const history = second.listSnapshots({ limit: 10 })
    assert.equal(history.length, 2)
    assert.ok(history.every((row) => row.id && row.observedAt && row.contentHash.startsWith('sha256:')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history filters by source, endpoint, before and after; limit bounds apply', () => {
  const dir = freshDir()
  try {
    const store = openStore(dir)
    const t0 = '2026-09-01T00:00:00.000Z'
    const t1 = '2026-09-02T00:00:00.000Z'
    const t2 = '2026-09-03T00:00:00.000Z'
    store.insertSnapshot({ sourceId: 'a', endpointId: 'e1', observedAt: t0, contentHash: 'sha256:0', data: { v: 0 }, metadata: {} })
    store.insertSnapshot({ sourceId: 'a', endpointId: 'e2', observedAt: t1, contentHash: 'sha256:1', data: { v: 1 }, metadata: {} })
    store.insertSnapshot({ sourceId: 'b', endpointId: 'e1', observedAt: t2, contentHash: 'sha256:2', data: { v: 2 }, metadata: {} })

    assert.equal(store.countSnapshots({}), 3)
    assert.equal(store.countSnapshots({ sourceId: 'a' }), 2)
    assert.equal(store.listSnapshots({ sourceId: 'a', endpointId: 'e1', limit: 10 }).length, 1)
    assert.equal(store.listSnapshots({ before: t2, limit: 10 }).length, 2)
    assert.equal(store.listSnapshots({ after: t1, limit: 10 }).length, 1)
    assert.equal(store.listSnapshots({ before: t2, after: t0, limit: 10 }).length, 1)
    // newest first
    const all = store.listSnapshots({ limit: 10 })
    assert.equal(all[0].observedAt, t2)
    assert.equal(all[2].observedAt, t0)
    // limit is honored
    assert.equal(store.listSnapshots({ limit: 2 }).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('values with quotes, unicode and sql metacharacters round-trip safely', () => {
  const dir = freshDir()
  try {
    const store = openStore(dir)
    const nasty = 'quote"; DROP TABLE snapshots;-- 中文 日本語 🌍'
    const { id } = store.insertSnapshot({
      sourceId: 's-quote',
      endpointId: 'e',
      observedAt: new Date().toISOString(),
      contentHash: 'sha256:x',
      data: { note: nasty },
      metadata: { warnings: [`field_not_found:${nasty}`] },
    })
    const snapshot = store.getSnapshot(id)
    assert.equal(snapshot.data.note, nasty)
    assert.equal(snapshot.metadata.warnings[0], `field_not_found:${nasty}`)
    assert.equal(store.countSnapshots({}), 1) // table intact
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('requireSnapshot throws snapshot_not_found for unknown ids', () => {
  const dir = freshDir()
  try {
    const store = openStore(dir)
    insertOne(store)
    assertThrowsCode('snapshot_not_found', () => requireSnapshot(store, 'snap-does-not-exist'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent snapshot writes all land (§58, in-process concurrency)', async () => {
  const dir = freshDir()
  try {
    const file = join(dir, 'worldsense.db')
    const handle = createStoreHandle({ resolvePath: () => file })
    const store = handle.ensure()
    const jobs = []
    for (let i = 0; i < 50; i += 1) {
      jobs.push(Promise.resolve().then(() =>
        store.insertSnapshot({
          sourceId: 'prod',
          endpointId: 'status',
          observedAt: new Date().toISOString(),
          contentHash: `sha256:${i}`,
          data: { i },
          metadata: {},
        }),
      ))
    }
    const inserted = await Promise.all(jobs)
    assert.equal(inserted.length, 50)
    assert.equal(new Set(inserted.map((entry) => entry.id)).size, 50, 'ids must be unique')
    assert.equal(store.countSnapshots({}), 50)
    handle.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the store handle is lazy: a bad path only errors at first use', () => {
  const handle = createStoreHandle({ resolvePath: () => '/nonexistent-root/worldsense/x.db' })
  assert.equal(handle.info, null)
  assert.throws(() => handle.ensure(), /worldsense|database|SQLITE/i)
  handle.close() // must not throw
})

test('dbPath resolution: default under DSH_HOME, ~/ expansion, relative in-plugin', () => {
  const home = '/home/tester'
  const env = { DSH_HOME: '/data/dsh' }
  assert.equal(defaultDbPath(env, home), '/data/dsh/worldsense/worldsense.db')
  assert.equal(defaultDbPath({}, home), join(home, '.dsh', 'worldsense', 'worldsense.db'))
  assert.equal(resolveDbPath('', env, home), '/data/dsh/worldsense/worldsense.db')
  assert.equal(resolveDbPath('/abs/x.db', env, home), '/abs/x.db')
  assert.equal(resolveDbPath('~/mine.db', env, home), join(home, 'mine.db'))
  assert.equal(resolveDbPath('rel.db', env, home), '/data/dsh/worldsense/rel.db')
})
