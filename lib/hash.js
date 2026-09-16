// lib/hash.js — Deterministic JSON serialization + SHA-256 content hashing.
// The content hash is the identity of an observation/snapshot: same sanitized
// data ⇒ same hash, regardless of object key insertion order; any value change
// ⇒ different hash. Key ordering is therefore a protocol concern, never an
// accident of JSON.parse or remote server key order.
import { createHash } from 'node:crypto'

// Stable stringify: object keys sorted (recursively), array order preserved,
// JSON scalar semantics. Numbers use their JSON form; anything JSON cannot
// represent (undefined, functions, symbols, bigints) normalizes to null so a
// hostile payload cannot crash hashing.
export function stableStringify(value) {
  return serialize(value, 0, new WeakSet())
}

function serialize(value, depth, seen) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return 'null'
    if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    return typeof value === 'string' ? JSON.stringify(value) : String(value)
  }
  if (seen.has(value)) return 'null' // cycles cannot exist in JSON.parse output; guard anyway
  if (depth > 512) return 'null'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, depth + 1, seen)).join(',')}]`
    }
    const keys = Object.keys(value).sort()
    const parts = []
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${serialize(value[key], depth + 1, seen)}`)
    }
    return `{${parts.join(',')}}`
  } finally {
    seen.delete(value)
  }
}

// SHA-256 over the stable serialization; returned as 'sha256:<hex>'.
export function contentHash(value) {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`
}
