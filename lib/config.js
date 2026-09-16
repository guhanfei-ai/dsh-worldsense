// lib/config.js — Source & endpoint configuration: normalization, fail-fast
// validation and resolution. This module is pure (no ctx, no IO).
//
// The trust boundary of WorldSense is THIS file: everything an agent can reach
// (source ids, endpoint ids, query parameter names/types, field aliases and
// their JSON Pointers, base URLs, auth modes) is defined here by an
// administrator. Nothing the agent supplies is ever treated as configuration.
//
// Config accepts two shapes and canonicalizes both:
//   - array form for `sources` (what the DSH settings schema persists)
//   - object-map form for `sources`, `endpoints`, `query` and `fields`
//     (natural for hand-written JSON, and what the README examples use)
// Literal secrets anywhere in source config are rejected outright.

import {
  APIKEY_REF_PREFIX,
  AUTH_API_KEY_HEADER,
  AUTH_BASIC,
  AUTH_BEARER,
  AUTH_NONE,
  BASIC_PASSWORD_REF_PREFIX,
  BASIC_USERNAME_REF_PREFIX,
  CREDENTIAL_REF_PATTERN,
  DEFAULT_API_KEY_HEADER,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  ENDPOINT_ID_PATTERN,
  FIELD_ALIAS_PATTERN,
  HARD_MAX_RESPONSE_BYTES,
  MAX_ENDPOINTS_PER_SOURCE,
  MAX_ENDPOINT_DESC_CHARS,
  MAX_FIELDS_PER_ENDPOINT,
  MAX_PARAM_VALUE_CHARS,
  MAX_QUERY_PARAMS_PER_ENDPOINT,
  MAX_SOURCE_DESC_CHARS,
  MAX_SOURCES,
  MAX_TIMEOUT_MS,
  MIN_MAX_RESPONSE_BYTES,
  MIN_TIMEOUT_MS,
  QUERY_PARAM_NAME_PATTERN,
  QUERY_PARAM_TYPES,
  SOURCE_ID_PATTERN,
  SOURCE_TYPE_HTTP_JSON,
  SUPPORTED_AUTH,
  SUPPORTED_SOURCE_TYPES,
  TOKEN_REF_PREFIX,
} from './constants.js'
import { validatePointer } from './jsonpointer.js'
import { isPlainObject, oneLine } from './util.js'

// Keys that must never appear as literal secrets in source config. If present
// we fail loudly and point the operator at the credential store, instead of
// silently ignoring them (which would leave a secret sitting in Git).
const FORBIDDEN_SECRET_KEYS = ['password', 'passwd', 'pwd', 'token', 'secret', 'apiKey', 'api_key', 'authorization', 'credential']

// ── Canonicalization helpers ─────────────────────────────────────────────────

function entriesFrom(mapOrArray, keyField) {
  if (Array.isArray(mapOrArray)) return mapOrArray.filter(isPlainObject)
  if (isPlainObject(mapOrArray)) {
    return Object.entries(mapOrArray)
      .map(([key, value]) => (isPlainObject(value) ? { [keyField]: key, ...value } : null))
      .filter(Boolean)
  }
  return []
}

function trimString(value, max, label) {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s) return ''
  return s.length > max ? s.slice(0, max) : s
}

// ── Base URL & endpoint path validation ──────────────────────────────────────

// Normalize and validate an administrator-configured base URL. Rejects embedded
// credentials, query strings and fragments; enforces HTTPS unless the host is
// loopback or the administrator explicitly allowed insecure HTTP.
export function normalizeBaseUrl(input, allowInsecureHttp = false, label = 'source baseUrl') {
  const value = String(input ?? '').trim()
  if (!value) throw new Error(`${label} is required.`)
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} must be an absolute http(s) URL.`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${label} must use https:// or http://.`)
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials; configure auth separately so secrets stay out of config and Git.`)
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain a query string or fragment.`)
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new Error(`Plain HTTP is disabled for non-loopback hosts. Use HTTPS, target a loopback address, or set allowInsecureHttp: true on the source (or globally) to accept it explicitly.`)
  }
  return url.toString().replace(/\/+$/, '')
}

// An endpoint path is a fixed RELATIVE path starting with '/'. It must never be
// able to escape the configured origin: no protocol-relative '//' (which
// resolves to a different host), no scheme ('://'), no query/fragment, no
// backslash or control characters.
const PATH_ALLOWED = /^\/[A-Za-z0-9_~.!$&'()*+,;=:@%/-]*$/

export function validateEndpointPath(path, label = 'endpoint path') {
  const value = String(path ?? '').trim()
  if (!value) throw new Error(`${label} is required.`)
  if (value.length > 512) throw new Error(`${label} must not exceed 512 characters.`)
  if (!value.startsWith('/')) {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} must be a relative path starting with '/' (e.g. "/api/status"); absolute URLs are not allowed.`)
  }
  if (value.startsWith('//')) {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} must not start with '//' — protocol-relative paths change the host.`)
  }
  if (value.includes('://') || value.includes('\\')) {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} must not contain '://' or backslashes.`)
  }
  if (value.includes('?') || value.includes('#')) {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} must not contain '?' or '#'; query parameters are declared per endpoint via "query".`)
  }
  if (!PATH_ALLOWED.test(value)) {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} contains characters that are not allowed in a fixed endpoint path.`)
  }
  // Percent-encoded escapes are legitimate in fixed paths (e.g. org%2Frepo),
  // but the DECODED form must still be a safe relative path: a %2f%2f run
  // could be normalized to '//' by a lenient upstream and confuse routing.
  try {
    const decoded = decodeURIComponent(value)
    if (decoded.includes('//') || decoded.includes(':\\') || decoded.includes('\\')) {
      throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} decodes to an unsafe path.`)
    }
  } catch (error) {
    if (error instanceof Error && /decodes to an unsafe path/.test(error.message)) throw error
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} contains an invalid percent-escape.`)
  }
  // Defense in depth: resolve against an https base and confirm nothing about
  // the path can change the origin or smuggle credentials.
  const resolved = new URL(value, 'https://worldsense.invalid')
  if (resolved.origin !== 'https://worldsense.invalid' || resolved.username || resolved.password) {
    throw new Error(`${label} ${JSON.stringify(oneLine(value, 120))} does not stay inside the configured origin.`)
  }
  return value
}

// ── Auth normalization ───────────────────────────────────────────────────────

function refSuffix(id) {
  return String(id ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64)
}

function validRefOrDerived(value, derived, label) {
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return derived
  if (!CREDENTIAL_REF_PATTERN.test(v)) {
    throw new Error(`${label} ${JSON.stringify(oneLine(v, 80))} is not a valid credential reference (letters, digits, underscore; must start with a letter or underscore).`)
  }
  return v
}

function normalizeAuth(rawAuth, sourceId, sourceLabel) {
  if (!rawAuth || typeof rawAuth !== 'object' || Array.isArray(rawAuth)) {
    return { type: AUTH_NONE }
  }
  // Reject literal secret keys inside the auth block outright.
  for (const key of ['token', 'password', 'passwd', 'secret', 'apiKey', 'api_key', 'value']) {
    if (typeof rawAuth[key] === 'string' && rawAuth[key].trim()) {
      throw new Error(`${sourceLabel}: auth must not contain a literal "${key}". Store secrets in the DSH credential store and reference them via "credential".`)
    }
  }
  const type = String(rawAuth.type ?? AUTH_NONE).trim().toLowerCase()
  if (!SUPPORTED_AUTH.has(type)) {
    throw new Error(`${sourceLabel}: unsupported auth type ${JSON.stringify(String(rawAuth.type ?? ''))}. Supported in v0.1: ${[...SUPPORTED_AUTH].join(', ')}.`)
  }
  if (type === AUTH_NONE) return { type: AUTH_NONE }

  const credential = typeof rawAuth.credential === 'string' ? rawAuth.credential.trim() : (typeof rawAuth.credentialRef === 'string' ? rawAuth.credentialRef.trim() : '')

  if (type === AUTH_BEARER) {
    return {
      type,
      credentialRef: validRefOrDerived(credential, `${TOKEN_REF_PREFIX}${refSuffix(sourceId)}`, `${sourceLabel}: bearer credential`),
    }
  }
  if (type === AUTH_API_KEY_HEADER) {
    const header = typeof rawAuth.header === 'string' && rawAuth.header.trim() ? rawAuth.header.trim() : DEFAULT_API_KEY_HEADER
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header)) {
      throw new Error(`${sourceLabel}: api-key-header auth has an invalid header name ${JSON.stringify(oneLine(header, 64))}.`)
    }
    return {
      type,
      header,
      credentialRef: validRefOrDerived(credential, `${APIKEY_REF_PREFIX}${refSuffix(sourceId)}`, `${sourceLabel}: api key credential`),
    }
  }
  // basic
  const username = typeof rawAuth.username === 'string' ? rawAuth.username.trim() : ''
  const usernameRef = validRefOrDerived(typeof rawAuth.usernameRef === 'string' ? rawAuth.usernameRef : '', `${BASIC_USERNAME_REF_PREFIX}${refSuffix(sourceId)}`, `${sourceLabel}: username credential`)
  const passwordRef = validRefOrDerived(typeof rawAuth.passwordRef === 'string' ? rawAuth.passwordRef : '', `${BASIC_PASSWORD_REF_PREFIX}${refSuffix(sourceId)}`, `${sourceLabel}: password credential`)
  return { type: AUTH_BASIC, username, usernameRef, passwordRef }
}

// ── Query parameter schemas ──────────────────────────────────────────────────

function normalizeQueryParam(name, raw, endpointLabel) {
  const label = `${endpointLabel}, query parameter ${JSON.stringify(name)}`
  if (!QUERY_PARAM_NAME_PATTERN.test(String(name))) {
    throw new Error(`${endpointLabel}: query parameter name ${JSON.stringify(String(name))} is invalid (1-64 chars: letters, digits, underscore, hyphen, dot; must start with alphanumeric/underscore).`)
  }
  const spec = isPlainObject(raw) ? raw : {}
  const type = String(spec.type ?? 'string').trim()
  if (!QUERY_PARAM_TYPES.has(type)) {
    throw new Error(`${label}: unsupported type ${JSON.stringify(type)}. Supported: ${[...QUERY_PARAM_TYPES].join(', ')}.`)
  }
  const required = spec.required === true
  const out = { name, type, required }

  if (type === 'enum') {
    const values = Array.isArray(spec.values) ? spec.values.map((v) => String(v)).filter((v) => v.length > 0) : []
    if (values.length === 0) throw new Error(`${label}: enum requires a non-empty "values" array.`)
    if (values.length > 32) throw new Error(`${label}: enum supports at most 32 values.`)
    if (new Set(values).size !== values.length) throw new Error(`${label}: enum values must be unique.`)
    out.values = values
  }
  if (type === 'integer' || type === 'number') {
    if (spec.min !== undefined) {
      const min = Number(spec.min)
      if (!Number.isFinite(min)) throw new Error(`${label}: "min" must be a number.`)
      out.min = min
    }
    if (spec.max !== undefined) {
      const max = Number(spec.max)
      if (!Number.isFinite(max)) throw new Error(`${label}: "max" must be a number.`)
      out.max = max
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) {
      throw new Error(`${label}: "min" must not exceed "max".`)
    }
  }
  if (type === 'string' || type === 'enum') {
    out.maxLength = Number.isInteger(spec.maxLength) && spec.maxLength > 0 ? Math.min(spec.maxLength, MAX_PARAM_VALUE_CHARS) : MAX_PARAM_VALUE_CHARS
  }
  if (spec.default !== undefined) {
    out.default = spec.default
    validateParamValue(out, spec.default, `${label} default`)
  }
  return out
}

function normalizeQuery(rawQuery, endpointLabel) {
  const entries = entriesFrom(rawQuery, 'name')
  if (entries.length > MAX_QUERY_PARAMS_PER_ENDPOINT) {
    throw new Error(`${endpointLabel}: too many query parameters (${entries.length}; limit ${MAX_QUERY_PARAMS_PER_ENDPOINT}).`)
  }
  const out = {}
  for (const entry of entries) {
    const name = String(entry.name ?? '')
    if (out[name]) throw new Error(`${endpointLabel}: duplicate query parameter ${JSON.stringify(name)}.`)
    out[name] = normalizeQueryParam(name, entry, endpointLabel)
  }
  return out
}

// ── Field aliases ────────────────────────────────────────────────────────────

// Fields accept two shapes: the map shorthand (alias → "/pointer" string, the
// common case) and the object form (alias → { pointer, required }). Unlike
// endpoints/query, scalar values are meaningful here, so this walks the raw
// entries directly instead of going through entriesFrom.
function fieldEntriesFrom(rawFields) {
  if (Array.isArray(rawFields)) return rawFields.filter(isPlainObject)
  if (isPlainObject(rawFields)) {
    return Object.entries(rawFields).map(([alias, value]) => {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { alias, pointer: String(value) }
      if (isPlainObject(value)) return { alias, ...value }
      return null
    }).filter(Boolean)
  }
  return []
}

function normalizeFields(rawFields, endpointLabel) {
  const entries = fieldEntriesFrom(rawFields)
  if (entries.length === 0) {
    throw new Error(`${endpointLabel}: at least one field alias is required (e.g. { "fields": { "status": "/status" } }).`)
  }
  if (entries.length > MAX_FIELDS_PER_ENDPOINT) {
    throw new Error(`${endpointLabel}: too many field aliases (${entries.length}; limit ${MAX_FIELDS_PER_ENDPOINT}).`)
  }
  const out = []
  for (const entry of entries) {
    const alias = String(entry.alias ?? '')
    if (!FIELD_ALIAS_PATTERN.test(alias)) {
      throw new Error(`${endpointLabel}: field alias ${JSON.stringify(alias)} is invalid (1-64 chars: letters, digits, underscore, hyphen, dot; must start with letter/digit/underscore).`)
    }
    const rawPointer = typeof entry.pointer === 'string' && entry.pointer.trim() ? entry.pointer.trim() : (typeof entry.path === 'string' ? entry.path.trim() : '')
    const pointer = validatePointer(rawPointer, `${endpointLabel}, field ${JSON.stringify(alias)}`)
    out.push({ alias, pointer, required: entry.required === true })
  }
  if (new Set(out.map((f) => f.alias)).size !== out.length) {
    throw new Error(`${endpointLabel}: field aliases must be unique.`)
  }
  return out
}

// ── Endpoints ────────────────────────────────────────────────────────────────

function normalizeEndpoints(rawEndpoints, sourceLabel) {
  const entries = entriesFrom(rawEndpoints, 'id')
  if (entries.length === 0) {
    throw new Error(`${sourceLabel}: at least one endpoint is required.`)
  }
  if (entries.length > MAX_ENDPOINTS_PER_SOURCE) {
    throw new Error(`${sourceLabel}: too many endpoints (${entries.length}; limit ${MAX_ENDPOINTS_PER_SOURCE}).`)
  }
  const out = []
  for (const entry of entries) {
    const id = String(entry.id ?? '')
    if (!ENDPOINT_ID_PATTERN.test(id)) {
      throw new Error(`${sourceLabel}: endpoint id ${JSON.stringify(id)} is invalid (1-64 chars: letters, digits, underscore, hyphen; must start with alphanumeric).`)
    }
    const endpointLabel = `${sourceLabel}, endpoint ${JSON.stringify(id)}`
    const path = validateEndpointPath(entry.path, `${endpointLabel} path`)
    out.push({
      id,
      description: trimString(entry.description, MAX_ENDPOINT_DESC_CHARS, 'description'),
      path,
      query: normalizeQuery(entry.query, endpointLabel),
      fields: normalizeFields(entry.fields, endpointLabel),
    })
  }
  if (new Set(out.map((e) => e.id)).size !== out.length) {
    throw new Error(`${sourceLabel}: endpoint ids must be unique.`)
  }
  return out
}

// ── Sources ──────────────────────────────────────────────────────────────────

function normalizeSource(entry, globalAllowInsecureHttp) {
  // No trim: an id with surrounding whitespace is a config mistake worth
  // surfacing, not silently normalizing into a different valid id.
  const id = String(entry.id ?? '')
  if (!SOURCE_ID_PATTERN.test(id)) {
    throw new Error(`Source id ${JSON.stringify(id)} is invalid (1-64 chars: letters, digits, underscore, hyphen; must start with alphanumeric).`)
  }
  const sourceLabel = `Source ${JSON.stringify(id)}`
  const type = String(entry.type ?? SOURCE_TYPE_HTTP_JSON).trim()
  if (!SUPPORTED_SOURCE_TYPES.has(type)) {
    throw new Error(`${sourceLabel}: unsupported type ${JSON.stringify(type)}. Supported in v0.1: ${[...SUPPORTED_SOURCE_TYPES].join(', ')}.`)
  }
  const allowInsecure = entry.allowInsecureHttp === true || globalAllowInsecureHttp === true
  const baseUrl = normalizeBaseUrl(entry.baseUrl ?? entry.url, allowInsecure, `${sourceLabel} baseUrl`)

  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (entry.timeoutMs !== undefined) {
    if (typeof entry.timeoutMs !== 'number' || !Number.isInteger(entry.timeoutMs) || entry.timeoutMs < MIN_TIMEOUT_MS || entry.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`${sourceLabel}: timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`)
    }
    timeoutMs = entry.timeoutMs
  }
  let maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  if (entry.maxResponseBytes !== undefined) {
    if (typeof entry.maxResponseBytes !== 'number' || !Number.isInteger(entry.maxResponseBytes) || entry.maxResponseBytes < MIN_MAX_RESPONSE_BYTES || entry.maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
      throw new Error(`${sourceLabel}: maxResponseBytes must be an integer between ${MIN_MAX_RESPONSE_BYTES} and ${HARD_MAX_RESPONSE_BYTES} (bytes).`)
    }
    maxResponseBytes = entry.maxResponseBytes
  }

  return {
    id,
    name: trimString(entry.name, 100, 'name') || id,
    description: trimString(entry.description, MAX_SOURCE_DESC_CHARS, 'description'),
    type,
    baseUrl,
    allowInsecureHttp: allowInsecure,
    auth: normalizeAuth(entry.auth, id, sourceLabel),
    timeoutMs,
    maxResponseBytes,
    endpoints: normalizeEndpoints(entry.endpoints, sourceLabel),
  }
}

// Validate one value against a normalized query-param spec. Used for admin
// defaults AND for agent-supplied params — identical rules for both, so a
// default can never be looser than what an agent is allowed to pass.
export function validateParamValue(spec, value, label) {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
      if (value.length > spec.maxLength) throw new Error(`${label} must not exceed ${spec.maxLength} characters.`)
      if (/[\r\n\t]/.test(value) || value !== value.trim()) throw new Error(`${label} must not contain control characters or surrounding whitespace.`)
      return value
    }
    case 'enum': {
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        throw new Error(`${label} must be one of: ${spec.values.map((v) => JSON.stringify(v)).join(', ')}.`)
      }
      return value
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} must be an integer.`)
      if (spec.min !== undefined && value < spec.min) throw new Error(`${label} must be >= ${spec.min}.`)
      if (spec.max !== undefined && value > spec.max) throw new Error(`${label} must be <= ${spec.max}.`)
      return value
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`)
      if (spec.min !== undefined && value < spec.min) throw new Error(`${label} must be >= ${spec.min}.`)
      if (spec.max !== undefined && value > spec.max) throw new Error(`${label} must be <= ${spec.max}.`)
      return value
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`)
      return value
    }
    default:
      throw new Error(`${label}: unsupported parameter type.`)
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

// Validate a raw config object at load time. Fail fast: a broken config must
// never survive until an agent call discovers it. Returns the value unchanged
// so the settings store persists what the operator wrote.
export function validateConfig(value) {
  const cfg = isPlainObject(value) ? value : {}
  const entries = entriesFrom(cfg.sources, 'id')
  if (entries.length > MAX_SOURCES) {
    throw new Error(`Too many sources (${entries.length}; limit ${MAX_SOURCES}).`)
  }
  const ids = new Set()
  for (const entry of entries) {
    const id = String(entry.id ?? '').trim()
    if (SOURCE_ID_PATTERN.test(id) && ids.has(id)) {
      throw new Error(`Duplicate source id ${JSON.stringify(id)}. Source ids must be unique.`)
    }
    if (SOURCE_ID_PATTERN.test(id)) ids.add(id)
    // Reject literal secrets in source config — they belong in the credential store.
    const refHint = 'Store secrets in the DSH credential store and reference them via auth.credential'
    for (const key of FORBIDDEN_SECRET_KEYS) {
      if (typeof entry[key] === 'string' && entry[key].trim()) {
        throw new Error(`${id ? `Source ${JSON.stringify(id)}` : 'A source'} must not contain a literal "${key}" in config. ${refHint} so they never enter Git.`)
      }
    }
    normalizeSource(entry, cfg.allowInsecureHttp === true)
  }
  return value
}

// Canonical, runtime-ready source list. Note: this re-runs normalization; all
// inputs were already validated at load time, so this cannot throw for configs
// that passed validateConfig.
export function effectiveSources(cfg) {
  const entries = entriesFrom(isPlainObject(cfg) ? cfg.sources : null, 'id')
  const out = []
  for (const entry of entries) {
    try {
      out.push(normalizeSource(entry, isPlainObject(cfg) && cfg.allowInsecureHttp === true))
    } catch {
      continue // unreachable for validated configs; defensive only
    }
  }
  return out
}

// Resolve a source by id (preferred) or name (case-insensitive). Throws a
// helpful, secret-free error listing configured ids when it cannot resolve.
export function resolveSource(cfg, sourceArg) {
  const sources = effectiveSources(cfg)
  const key = String(sourceArg ?? '').trim()
  if (key) {
    const byId = sources.find((s) => s.id === key)
    if (byId) return byId
    const byName = sources.find((s) => s.name.toLowerCase() === key.toLowerCase())
    if (byName) return byName
    const ids = sources.map((s) => JSON.stringify(s.id)).join(', ')
    throw new Error(`source_not_found: unknown source ${JSON.stringify(oneLine(key, 80))}. Configured sources: ${ids || '(none)'}. Call worldsense_sources to list them.`)
  }
  if (sources.length === 0) {
    throw new Error('source_not_found: no sources are configured. Add one in Settings → Plugins (or provide "sources" in the plugin configuration).')
  }
  if (sources.length === 1) return sources[0]
  const ids = sources.map((s) => JSON.stringify(s.id)).join(', ')
  throw new Error(`source_not_found: multiple sources are configured (${ids}); pass an explicit source. Call worldsense_sources to list them.`)
}

// Resolve an endpoint within a source. Omitting endpointArg resolves to the
// first configured endpoint (definition order) — deterministic and disclosed.
export function resolveEndpoint(source, endpointArg, { required = false } = {}) {
  const key = String(endpointArg ?? '').trim()
  if (!key) {
    if (required) {
      throw new Error(`endpoint_not_found: endpoint is required for source ${JSON.stringify(source.id)}. Available: ${source.endpoints.map((e) => JSON.stringify(e.id)).join(', ')}.`)
    }
    return source.endpoints[0]
  }
  const byId = source.endpoints.find((e) => e.id === key)
  if (byId) return byId
  throw new Error(`endpoint_not_found: source ${JSON.stringify(source.id)} has no endpoint ${JSON.stringify(oneLine(key, 80))}. Available: ${source.endpoints.map((e) => JSON.stringify(e.id)).join(', ')}.`)
}

// Display-safe base URL (defensively strips userinfo; by construction there is
// none — normalizeBaseUrl rejects embedded credentials).
export function sanitizeBaseUrlForDisplay(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return '(not set)'
  try {
    const u = new URL(raw)
    u.username = ''
    u.password = ''
    return u.toString().replace(/\/+$/, '')
  } catch {
    return '(invalid url)'
  }
}
