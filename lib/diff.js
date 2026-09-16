// lib/diff.js — Deterministic structural JSON diff between two snapshots'
// sanitized data. Objects: added / removed / changed keys (recursively, keys in
// sorted order for determinism). Arrays: compared by index in v0.1 — no smart
// collection matching. Every dimension is bounded so a huge difference produces
// a small, honestly-flagged result instead of a context bomb.
import { MAX_DIFF_DEPTH, MAX_DIFF_ENTRIES, MAX_DIFF_VALUE_CHARS } from './constants.js'
import { stableStringify } from './hash.js'
import { truncate } from './util.js'

// Render a diff value: stable serialization, bounded length.
function renderValue(value) {
  const text = stableStringify(value)
  return text.length > MAX_DIFF_VALUE_CHARS ? `${truncate(text, MAX_DIFF_VALUE_CHARS)}` : text
}

function escapeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1')
}

// Compare `before` and `after`; returns
// { changed, added, removed, truncated, truncationReasons }.
export function diffJson(before, after, { maxEntries = MAX_DIFF_ENTRIES, maxDepth = MAX_DIFF_DEPTH } = {}) {
  const state = {
    changed: [],
    added: [],
    removed: [],
    truncated: false,
    truncationReasons: [],
    count: 0,
  }

  const room = () => state.count < maxEntries
  const spend = () => {
    state.count += 1
    if (state.count >= maxEntries) {
      state.truncated = true
      if (!state.truncationReasons.includes('diff_entry_limit')) state.truncationReasons.push('diff_entry_limit')
    }
  }

  walk(before, after, '', 0, state, room, spend)
  return {
    changed: state.changed,
    added: state.added,
    removed: state.removed,
    truncated: state.truncated,
    truncationReasons: state.truncationReasons,
  }
}

function walk(before, after, path, depth, state, room, spend) {
  if (!room()) return

  // Type mismatch at any level is a single changed entry; no recursion.
  const beforeIsArray = Array.isArray(before)
  const afterIsArray = Array.isArray(after)
  const beforeIsObject = beforeIsArray ? false : isRecord(before)
  const afterIsObject = afterIsArray ? false : isRecord(after)
  if (beforeIsArray !== afterIsArray || beforeIsObject !== afterIsObject) {
    state.changed.push({ path: path || '/', before: renderValue(before), after: renderValue(after) })
    spend()
    return
  }

  // Depth guard: compare this subtree as one opaque changed entry.
  if (depth >= MAX_DIFF_DEPTH) {
    if (!stableEqual(before, after)) {
      state.changed.push({ path: path || '/', before: renderValue(before), after: renderValue(after) })
      spend()
    }
    return
  }

  if (beforeIsArray) {
    const shared = Math.min(before.length, after.length)
    for (let i = 0; i < shared && room(); i += 1) {
      walk(before[i], after[i], `${path}/${i}`, depth + 1, state, room, spend)
    }
    for (let i = shared; i < before.length && room(); i += 1) {
      state.removed.push({ path: `${path}/${i}`, before: renderValue(before[i]) })
      spend()
    }
    for (let i = shared; i < after.length && room(); i += 1) {
      state.added.push({ path: `${path}/${i}`, after: renderValue(after[i]) })
      spend()
    }
    return
  }

  if (beforeIsObject) {
    const beforeKeys = Object.keys(before).sort()
    const afterKeys = Object.keys(after).sort()
    const afterSet = new Set(afterKeys)
    const beforeSet = new Set(beforeKeys)
    for (const key of beforeKeys) {
      if (!room()) return
      const keyPath = `${path}/${escapeToken(key)}`
      if (!afterSet.has(key)) {
        state.removed.push({ path: keyPath, before: renderValue(before[key]) })
        spend()
        continue
      }
      walk(before[key], after[key], keyPath, depth + 1, state, room, spend)
    }
    for (const key of afterKeys) {
      if (!room()) return
      if (!beforeSet.has(key)) {
        state.added.push({ path: `${path}/${escapeToken(key)}`, after: renderValue(after[key]) })
        spend()
      }
    }
    return
  }

  // Scalars (and null): JSON equality via stable serialization.
  if (!stableEqual(before, after)) {
    state.changed.push({ path: path || '/', before: renderValue(before), after: renderValue(after) })
    spend()
  }
}

function stableEqual(a, b) {
  return stableStringify(a) === stableStringify(b)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
