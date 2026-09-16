// lib/observation.js — The perception pipeline. One read becomes one
// WorldObservation:
//
//   resolve source+endpoint → validate whitelisted params → build confined URL
//   → resolve credentials into headers → GET (bounded) → parse JSON
//   → select admin-aliased fields via JSON Pointer → prune oversized values
//   → redact secrets → hash the sanitized data → assemble provenance
//
// Truncation semantics (learned the hard way in dsh-searchops): `truncated`
// is true ONLY when WorldSense itself dropped data it already held because of
// a budget. A small remote answer is NOT truncation, and remote-side paging is
// never guessed at.
import {
  MAX_DATA_JSON_BYTES,
  MAX_FIELD_VALUE_CHARS,
  MAX_FIELD_VALUE_DEPTH,
  MAX_FIELD_VALUE_ITEMS,
  MAX_FIELDS_PER_READ,
  MAX_QUERY_STRING_CHARS,
  MAX_WARNINGS,
  TRUNCATION_MARK,
} from './constants.js'
import { resolveEndpoint, resolveSource, validateParamValue } from './config.js'
import { CODES, fail } from './failures.js'
import { buildRequestUrl, fetchJson } from './http.js'
import { contentHash, stableStringify } from './hash.js'
import { getByPointer } from './jsonpointer.js'
import { REDACTED, pointerTouchesSensitiveKey, redactValue } from './redact.js'
import { byteLength, isPlainObject, nowIso, oneLine, truncate } from './util.js'

// ── Whitelisted query parameter validation ──────────────────────────────────

// Validate agent-supplied params against the endpoint's whitelist. Unknown
// names, wrong types, out-of-range values and raw query strings are all
// rejected; defaults are applied for omitted optional params.
export function validateParams(endpoint, paramsArg) {
  if (paramsArg === undefined || paramsArg === null) paramsArg = {}
  if (!isPlainObject(paramsArg)) {
    throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: params must be an object of whitelisted query parameters for endpoint ${JSON.stringify(endpoint.id)}.`)
  }
  const applied = {}
  const search = new URLSearchParams()
  for (const [name, spec] of Object.entries(endpoint.query)) {
    const raw = paramsArg[name] === undefined ? spec.default : paramsArg[name]
    if (raw === undefined || raw === null || raw === '') {
      if (spec.required) {
        throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: parameter ${JSON.stringify(name)} is required for endpoint ${JSON.stringify(endpoint.id)} (${describeParam(spec)}).`)
      }
      continue
    }
    let value
    try {
      value = validateParamValue(spec, raw, `invalid_parameter: parameter ${JSON.stringify(name)}`)
    } catch (error) {
      throw fail(CODES.INVALID_PARAMETER, `${error instanceof Error ? error.message : String(error)} (endpoint ${JSON.stringify(endpoint.id)}, ${describeParam(spec)})`)
    }
    applied[name] = value
    search.set(name, spec.type === 'boolean' || spec.type === 'integer' || spec.type === 'number' ? String(value) : value)
  }
  const unknown = Object.keys(paramsArg).filter((key) => !Object.prototype.hasOwnProperty.call(endpoint.query, key))
  if (unknown.length > 0) {
    const allowed = Object.keys(endpoint.query)
    throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: unknown parameter(s) ${unknown.map((k) => JSON.stringify(oneLine(k, 64))).join(', ')} for endpoint ${JSON.stringify(endpoint.id)}. Allowed: ${allowed.length ? allowed.map((k) => JSON.stringify(k)).join(', ') : '(none — this endpoint takes no params)'}.`)
  }
  const queryString = search.toString()
  if (queryString.length > MAX_QUERY_STRING_CHARS) {
    throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: the validated query string for endpoint ${JSON.stringify(endpoint.id)} exceeds ${MAX_QUERY_STRING_CHARS} characters.`)
  }
  return { applied, search }
}

function describeParam(spec) {
  const bits = [`type=${spec.type}`]
  if (spec.type === 'enum') bits.push(`values=[${spec.values.join('|')}]`)
  if (spec.min !== undefined) bits.push(`min=${spec.min}`)
  if (spec.max !== undefined) bits.push(`max=${spec.max}`)
  return bits.join(', ')
}

// ── Field selection ──────────────────────────────────────────────────────────

// Resolve the agent's `fields` argument to admin-defined aliases. Unknown
// aliases are rejected with the valid list. Omitted → all aliases, capped at
// MAX_FIELDS_PER_READ with an honest truncation reason.
export function resolveFieldSelection(endpoint, fieldsArg) {
  const all = endpoint.fields
  if (fieldsArg === undefined || fieldsArg === null) {
    const selected = all.slice(0, MAX_FIELDS_PER_READ)
    const reason = all.length > selected.length ? ['field_count_limit'] : []
    return { selected, reason }
  }
  if (!Array.isArray(fieldsArg)) {
    throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: fields must be an array of field aliases configured for endpoint ${JSON.stringify(endpoint.id)}.`)
  }
  if (fieldsArg.length > MAX_FIELDS_PER_READ) {
    throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: at most ${MAX_FIELDS_PER_READ} fields may be selected per read (got ${fieldsArg.length}).`)
  }
  const valid = new Set(all.map((f) => f.alias))
  const seen = new Set()
  const selected = []
  for (const item of fieldsArg) {
    const alias = String(item ?? '')
    if (!valid.has(alias)) {
      throw fail(CODES.INVALID_PARAMETER, `invalid_parameter: field ${JSON.stringify(oneLine(alias, 64))} is not configured for endpoint ${JSON.stringify(endpoint.id)}. Valid aliases: ${all.map((f) => JSON.stringify(f.alias)).join(', ')}.`)
    }
    if (seen.has(alias)) continue
    seen.add(alias)
    selected.push(all.find((f) => f.alias === alias))
  }
  return { selected, reason: [] }
}

// ── Value bounding ───────────────────────────────────────────────────────────

// Prune one selected value to the per-value budget: max depth, max array
// items, max string chars. Returns { value, pruned }.
export function boundValue(value, depth = 0) {
  let pruned = false
  const walk = (node, level) => {
    if (level >= MAX_FIELD_VALUE_DEPTH) {
      pruned = true
      return `${TRUNCATION_MARK} (depth > ${MAX_FIELD_VALUE_DEPTH})`
    }
    if (typeof node === 'string') {
      if (node.length > MAX_FIELD_VALUE_CHARS) {
        pruned = true
        return truncate(node, MAX_FIELD_VALUE_CHARS)
      }
      return node
    }
    if (node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      if (node.length > MAX_FIELD_VALUE_ITEMS) {
        pruned = true
        const kept = node.slice(0, MAX_FIELD_VALUE_ITEMS).map((item) => walk(item, level + 1))
        kept.push(`${TRUNCATION_MARK} (${node.length - MAX_FIELD_VALUE_ITEMS} more item(s))`)
        return kept
      }
      return node.map((item) => walk(item, level + 1))
    }
    const out = {}
    for (const [key, item] of Object.entries(node)) {
      out[key] = walk(item, level + 1)
    }
    return out
  }
  return { value: walk(value, depth), pruned }
}

// ── The pipeline ─────────────────────────────────────────────────────────────

// Perform one bounded observation. `deps` supplies credential resolution and
// the HTTP fetch (injected by runtime.js; tests fake them). Returns a
// WorldObservation; never persists anything.
export async function observe(deps, cfg, { sourceArg, endpointArg, fieldsArg, paramsArg, signal }) {
  const source = resolveSource(cfg, sourceArg)
  const endpoint = resolveEndpoint(source, endpointArg, { required: true })

  // Validate everything derivable BEFORE any network side effect: a bad
  // fields/params argument must fail without the request ever leaving.
  const { applied, search } = validateParams(endpoint, paramsArg)
  const { selected, reason: selectionReasons } = resolveFieldSelection(endpoint, fieldsArg)
  const url = buildRequestUrl(source.baseUrl, endpoint.path, search)
  const headers = await deps.buildHeaders(source)
  const fetched = await fetchJson({
    url,
    headers,
    timeoutMs: source.timeoutMs,
    maxResponseBytes: source.maxResponseBytes,
    signal,
    sourceId: source.id,
    endpointId: endpoint.id,
  })
  const data = {}
  const warnings = []
  const truncationReasons = [...selectionReasons]
  let prunedAny = false

  for (const field of selected) {
    const { found, value } = getByPointer(fetched.json, field.pointer)
    if (!found) {
      if (field.required) {
        throw fail(CODES.FIELD_NOT_FOUND, `field_not_found: required field ${JSON.stringify(field.alias)} (pointer ${JSON.stringify(field.pointer)}) is absent in the response from source ${JSON.stringify(source.id)} endpoint ${JSON.stringify(endpoint.id)}.`)
      }
      if (warnings.length < MAX_WARNINGS) warnings.push(`field_not_found:${field.alias}`)
      continue
    }
    if (pointerTouchesSensitiveKey(field.pointer)) {
      // The admin's pointer selected through a sensitive key (e.g. /db/password).
      // Redaction boundary applies even when the field config is wrong.
      data[field.alias] = REDACTED
      continue
    }
    const bounded = boundValue(value)
    if (bounded.pruned) prunedAny = true
    data[field.alias] = redactValue(bounded.value)
    if (byteLength(stableStringify(data)) > MAX_DATA_JSON_BYTES) {
      // The accumulated data object crossed the budget: drop this field and stop.
      delete data[field.alias]
      if (!truncationReasons.includes('data_byte_limit')) truncationReasons.push('data_byte_limit')
      if (warnings.length < MAX_WARNINGS) warnings.push(`data_budget_reached:${field.alias} not included`)
      break
    }
  }
  if (prunedAny && !truncationReasons.includes('field_value_limit')) truncationReasons.push('field_value_limit')

  return {
    source: source.id,
    endpoint: endpoint.id,
    observedAt: nowIso(),
    data,
    provenance: {
      source: source.id,
      endpoint: endpoint.id,
      method: 'GET',
      url,
      params: applied,
    },
    contentHash: contentHash(data),
    bytesReceived: fetched.bytesReceived,
    latencyMs: fetched.latencyMs,
    httpStatus: fetched.status,
    truncated: truncationReasons.length > 0,
    truncationReasons,
    warnings,
  }
}
