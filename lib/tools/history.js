// lib/tools/history.js — Evidence over time:
//   worldsense_history — bounded metadata listing of saved snapshots
//   worldsense_diff   — deterministic structural diff between two snapshots
// Computed by the plugin, never by the LLM. All output bounded.
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_HISTORY_LIMIT,
  MAX_DIFF_ENTRIES,
  MAX_HISTORY_LIMIT,
  TOOL_TIMEOUT_MS,
} from '../constants.js'
import { diffJson } from '../diff.js'
import { requireSnapshot } from '../store.js'
import { oneLine, parseIsoTimestamp, requireBoundedInteger, textOut } from '../util.js'

export function defineWorldsenseHistoryTool(rt) {
  return defineTool({
    name: 'worldsense_history',
    description: `List saved snapshots (metadata only — no data bodies): id, source, endpoint, observedAt, contentHash, bytesReceived, truncation flag, warning count. Filters: source, endpoint, and/or before/after (ISO-8601 timestamps). Default limit ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT}. Use the ids with worldsense_diff to compare two points in time.`,
    parameters: {
      source: { type: 'string', description: 'Optional source id filter (as listed by worldsense_sources).' },
      endpoint: { type: 'string', description: 'Optional endpoint id filter (usually together with source).' },
      before: { type: 'string', description: 'Optional ISO-8601 timestamp; only snapshots observed strictly before it.' },
      after: { type: 'string', description: 'Optional ISO-8601 timestamp; only snapshots observed strictly after it.' },
      limit: { type: 'number', description: `Optional page size, 1-${MAX_HISTORY_LIMIT}. Defaults to ${DEFAULT_HISTORY_LIMIT}.` },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `List world snapshots${args?.source ? ` for ${oneLine(String(args.source), 40)}` : ''}`, kind: 'read' }),
    async execute(args) {
      const before = args.before ? parseIsoTimestamp(args.before, 'before') : undefined
      const after = args.after ? parseIsoTimestamp(args.after, 'after') : undefined
      const limit = requireBoundedInteger(args.limit, 'limit', 1, MAX_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT)
      const filters = {
        sourceId: args.source ? String(args.source).trim() : undefined,
        endpointId: args.endpoint ? String(args.endpoint).trim() : undefined,
        before,
        after,
      }
      const store = rt.store()
      const rows = store.listSnapshots({ ...filters, limit })
      const total = store.countSnapshots(filters)
      if (rows.length === 0) return '(no snapshots match — capture evidence with worldsense_snapshot first)'
      const lines = rows.map((row) =>
        [
          `id=${JSON.stringify(row.id)}`,
          `source=${JSON.stringify(row.sourceId)}`,
          `endpoint=${JSON.stringify(row.endpointId)}`,
          `observedAt=${row.observedAt}`,
          `contentHash=${row.contentHash}`,
          `bytes=${row.bytesReceived ?? '-'}`,
          `truncated=${row.truncated ? 'true' : 'false'}`,
          `warnings=${row.warnings}`,
        ].join(' '),
      )
      if (rows.length < total) {
        const oldest = rows[rows.length - 1].observedAt
        lines.push(`budget: ${rows.length} of ${total} snapshot(s) shown (limit ${limit}); pass before=${JSON.stringify(oldest)} to page older ones, or raise the limit (max ${MAX_HISTORY_LIMIT}).`)
      }
      return lines.join('\n')
    },
  })
}

export function defineWorldsenseDiffTool(rt) {
  return defineTool({
    name: 'worldsense_diff',
    description: `Compare two saved snapshots and return a deterministic structural JSON diff: changed entries with path/before/after, plus added and removed paths. Objects diff by key, arrays by index. Bounded to ${MAX_DIFF_ENTRIES} entries with an honest truncation flag. Identical content hashes short-circuit to an empty diff. The plugin computes the diff — never diff by eye.`,
    parameters: {
      before: { type: 'string', required: true, description: 'Snapshot id of the earlier state (from worldsense_history).' },
      after: { type: 'string', required: true, description: 'Snapshot id of the later state (from worldsense_history).' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Diff world snapshots ${oneLine(String(args?.before ?? ''), 24)} → ${oneLine(String(args?.after ?? ''), 24)}`, kind: 'read' }),
    async execute(args) {
      const store = rt.store()
      const before = requireSnapshot(store, args.before)
      const after = requireSnapshot(store, args.after)

      const header = [
        `before=${summarizeSnapshot(before)}`,
        `after=${summarizeSnapshot(after)}`,
      ]
      if (before.contentHash === after.contentHash) {
        return [...header, 'sameContent=true', 'changed=[] added=[] removed=[]'].join('\n')
      }

      const result = diffJson(before.data, after.data)
      const lines = [...header, 'sameContent=false']
      const changed = result.changed.map((entry) => `changed ${entry.path}: ${entry.before} -> ${entry.after}`)
      const added = result.added.map((entry) => `added ${entry.path}: ${entry.after}`)
      const removed = result.removed.map((entry) => `removed ${entry.path}: ${entry.before}`)
      lines.push(...changed, ...added, ...removed)
      if (result.truncated) {
        lines.push(`budget: diff truncated at ${MAX_DIFF_ENTRIES} entries (${result.truncationReasons.join(',')}); narrow the compared fields or compare more frequently to keep snapshots close together.`)
      }
      return lines.join('\n')
    },
  })
}

function summarizeSnapshot(snapshot) {
  return `{id:${JSON.stringify(snapshot.id)}, source:${JSON.stringify(snapshot.sourceId)}, endpoint:${JSON.stringify(snapshot.endpointId)}, observedAt:${snapshot.observedAt}, contentHash:${snapshot.contentHash}}`
}
