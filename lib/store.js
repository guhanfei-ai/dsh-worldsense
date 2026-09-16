// lib/store.js — The local SQLite snapshot store (node:sqlite, a Node builtin
// since 22.5 — no native compilation, no ORM, no server).
//
// Persistence rules:
//   • Only SANITIZED observations are stored: data is already field-selected,
//     pruned and redacted before it reaches here. Credentials, auth headers,
//     cookies and raw upstream bodies never enter this file.
//   • All SQL is parameterized; identifiers never come from outside.
//   • WAL + busy_timeout so concurrent tool calls in one process never hit
//     "database is locked".
//   • Schema version lives in PRAGMA user_version; migrations are append-only
//     and run inside transactions.
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { mkdirSync } from 'node:fs'

import { BUSY_TIMEOUT_MS, DB_FILE_NAME, DB_SUBDIR } from './constants.js'
import { CODES, fail } from './failures.js'
import { stableStringify } from './hash.js'
import { generateSnapshotId, nowIso } from './util.js'

export const SCHEMA_VERSION = 1

// v1: one row per snapshot. data_json holds the sanitized selected data
// (stable serialization); metadata_json holds provenance, warnings, truncation
// reasons, params, bytes, latency and http status.
const MIGRATIONS = Object.freeze([
  {
    version: 1,
    sql: `
CREATE TABLE snapshots (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  endpoint_id    TEXT NOT NULL,
  observed_at    TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  data_json      TEXT NOT NULL,
  metadata_json  TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_snapshots_source_endpoint_observed ON snapshots (source_id, endpoint_id, observed_at DESC);
CREATE INDEX idx_snapshots_observed ON snapshots (observed_at DESC);
`,
  },
])

function currentVersion(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const value = row ? Object.values(row)[0] : 0
  return Number(value) || 0
}

function migrate(db) {
  const from = currentVersion(db)
  const applied = []
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      // PRAGMA cannot be parameter-bound; the version comes from a local
      // constant table, never from external input.
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // the transaction may already have rolled back on error
      }
      throw new Error(`worldsense schema migration ${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    applied.push(migration.version)
  }
  if (from > SCHEMA_VERSION) {
    throw new Error(`worldsense database schema is newer (v${from}) than this plugin supports (v${SCHEMA_VERSION}); upgrade dsh-worldsense instead of downgrading the database.`)
  }
  return { from, to: Math.max(from, SCHEMA_VERSION), applied }
}

// ── Path resolution ──────────────────────────────────────────────────────────

// Plugin data directory: $DSH_HOME/worldsense, DSH_HOME defaulting to ~/.dsh
// (same convention as dsh-introspect and the DSH bundle's storage config).
export function defaultDataDir(env = process.env, home = homedir()) {
  const dshHome = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(home, '.dsh')
  return join(dshHome, DB_SUBDIR)
}

export function defaultDbPath(env = process.env, home = homedir()) {
  return join(defaultDataDir(env, home), DB_FILE_NAME)
}

// Configured dbPath: '~/' expands, a relative path resolves inside the plugin
// data directory, empty uses the default.
export function resolveDbPath(configured, env = process.env, home = homedir()) {
  if (typeof configured !== 'string' || !configured.trim()) return defaultDbPath(env, home)
  let value = configured.trim()
  if (value === '~' || value.startsWith('~/')) value = join(home, value.slice(2))
  return isAbsolute(value) ? resolvePath(value) : resolvePath(defaultDataDir(env, home), value)
}

// ── Open / close ─────────────────────────────────────────────────────────────

export function openDatabase(file) {
  if (typeof file !== 'string' || !file) throw new Error('worldsense: database path is required')
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    const result = migrate(db)
    return { db, file, schemaVersion: SCHEMA_VERSION, migrated: result.applied.length > 0 }
  } catch (error) {
    try {
      db.close()
    } catch {
      // close may itself throw while opening failed; ignore the secondary error
    }
    throw error
  }
}

// A lazy handle: the file opens on first use and reopens if the configured path
// changes; callers close it on plugin unload. A bad path makes tools error at
// call time instead of failing the plugin load.
export function createStoreHandle({ resolvePath }) {
  let current = null
  return {
    ensure() {
      const file = resolvePath()
      if (current && current.file === file) return current.store
      if (current) this.close()
      const opened = openDatabase(file)
      current = { ...opened, store: null }
      current.store = createSnapshotStore(opened.db)
      return current.store
    },
    close() {
      const handle = current
      current = null
      if (!handle) return
      try {
        handle.db.close()
      } catch {
        // a failed close must not break unload
      }
    },
    get info() {
      return current ? { file: current.file, schemaVersion: current.schemaVersion } : null
    },
  }
}

// ── Snapshot store operations (all parameterized) ───────────────────────────

export function createSnapshotStore(db) {
  const insertStmt = () => db.prepare(
    'INSERT INTO snapshots (id, source_id, endpoint_id, observed_at, content_hash, data_json, metadata_json, schema_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const getByIdStmt = () => db.prepare('SELECT * FROM snapshots WHERE id = ?')

  function insertSnapshot({ sourceId, endpointId, observedAt, contentHash, data, metadata }) {
    const id = generateSnapshotId()
    const dataJson = stableStringify(data)
    const metadataJson = stableStringify(metadata ?? {})
    insertStmt().run(id, sourceId, endpointId, observedAt, contentHash, dataJson, metadataJson, SCHEMA_VERSION, nowIso())
    return { id, dataJson, metadataJson }
  }

  function rowToSnapshot(row) {
    if (!row) return null
    return {
      id: row.id,
      sourceId: row.source_id,
      endpointId: row.endpoint_id,
      observedAt: row.observed_at,
      contentHash: row.content_hash,
      data: JSON.parse(row.data_json),
      metadata: JSON.parse(row.metadata_json),
      schemaVersion: row.schema_version,
      createdAt: row.created_at,
    }
  }

  // Metadata-only row projection for listings (bodies stay in the DB).
  function getSnapshot(id) {
    const row = getByIdStmt().get(String(id ?? ''))
    return rowToSnapshot(row)
  }

  function listSnapshots({ sourceId, endpointId, before, after, limit }) {
    const clauses = []
    const params = []
    if (sourceId) {
      clauses.push('source_id = ?')
      params.push(sourceId)
    }
    if (endpointId) {
      clauses.push('endpoint_id = ?')
      params.push(endpointId)
    }
    if (before) {
      clauses.push('observed_at < ?')
      params.push(before)
    }
    if (after) {
      clauses.push('observed_at > ?')
      params.push(after)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = db.prepare(
      `SELECT id, source_id, endpoint_id, observed_at, content_hash, metadata_json FROM snapshots ${where} ORDER BY observed_at DESC, id DESC LIMIT ?`,
    ).all(...params, Math.max(1, Math.floor(Number(limit) || 20)))
    return rows.map((row) => {
      let meta = {}
      try {
        meta = JSON.parse(row.metadata_json)
      } catch {
        meta = {}
      }
      return {
        id: row.id,
        sourceId: row.source_id,
        endpointId: row.endpoint_id,
        observedAt: row.observed_at,
        contentHash: row.content_hash,
        truncated: Boolean(meta.truncated),
        warnings: Array.isArray(meta.warnings) ? meta.warnings.length : 0,
        bytesReceived: Number.isFinite(meta.bytesReceived) ? meta.bytesReceived : null,
      }
    })
  }

  function countSnapshots({ sourceId, endpointId, before, after } = {}) {
    const clauses = []
    const params = []
    if (sourceId) {
      clauses.push('source_id = ?')
      params.push(sourceId)
    }
    if (endpointId) {
      clauses.push('endpoint_id = ?')
      params.push(endpointId)
    }
    if (before) {
      clauses.push('observed_at < ?')
      params.push(before)
    }
    if (after) {
      clauses.push('observed_at > ?')
      params.push(after)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = db.prepare(`SELECT COUNT(*) AS n FROM snapshots ${where}`).get(...params)
    return Number(row?.n ?? 0)
  }

  return { insertSnapshot, getSnapshot, listSnapshots, countSnapshots }
}

// Load a snapshot for diff/history tools; snapshot_not_found is a first-class
// outcome with the offending id echoed (bounded).
export function requireSnapshot(store, id) {
  const snapshot = store.getSnapshot(String(id ?? '').trim())
  if (!snapshot) {
    throw fail(CODES.SNAPSHOT_NOT_FOUND, `snapshot_not_found: no snapshot with id ${JSON.stringify(String(id ?? '').slice(0, 64))}. Call worldsense_history to list snapshot ids.`)
  }
  return snapshot
}
