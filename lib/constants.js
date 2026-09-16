// lib/constants.js — Timeouts, size caps and format constraints in one place, so
// the security envelope of WorldSense is easy to audit and tune. Every bound here
// exists to stop one agent call from pulling gigabytes of remote JSON, holding a
// connection open forever, or leaking a credential into a result, a snapshot or a
// log line.

// ── Plugin identity ─────────────────────────────────────────────────────────
export const SETTINGS_NAMESPACE = 'worldsense'

// ── Source types ─────────────────────────────────────────────────────────────
// v0.1 implements exactly one adapter: plain GET + JSON. The set exists so the
// config layer can fail fast on anything else instead of faking support.
export const SOURCE_TYPE_HTTP_JSON = 'http-json'
export const SUPPORTED_SOURCE_TYPES = new Set([SOURCE_TYPE_HTTP_JSON])

// ── Credentials ──────────────────────────────────────────────────────────────
// Credential *references* live in config; secret *values* live only in the DSH
// credential store and are resolved at request time. Refs must be safe
// identifiers. Per-source refs are derived from the source id (see config.js).
export const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const TOKEN_REF_PREFIX = 'WORLDSENSE_TOKEN_'
export const APIKEY_REF_PREFIX = 'WORLDSENSE_APIKEY_'
export const BASIC_USERNAME_REF_PREFIX = 'WORLDSENSE_USERNAME_'
export const BASIC_PASSWORD_REF_PREFIX = 'WORLDSENSE_PASSWORD_'

// ── Auth modes ───────────────────────────────────────────────────────────────
// none | bearer | api-key-header | basic. The header name for api-key-header is
// administrator config; the agent can never choose it.
export const AUTH_NONE = 'none'
export const AUTH_BEARER = 'bearer'
export const AUTH_API_KEY_HEADER = 'api-key-header'
export const AUTH_BASIC = 'basic'
export const SUPPORTED_AUTH = new Set([AUTH_NONE, AUTH_BEARER, AUTH_API_KEY_HEADER, AUTH_BASIC])
export const DEFAULT_API_KEY_HEADER = 'X-API-Key'

// ── Identifiers ──────────────────────────────────────────────────────────────
export const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
export const ENDPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
// Field aliases become keys of the observation `data` object.
export const FIELD_ALIAS_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
export const QUERY_PARAM_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/

// ── Configuration size limits ────────────────────────────────────────────────
export const MAX_SOURCES = 50
export const MAX_ENDPOINTS_PER_SOURCE = 50
export const MAX_QUERY_PARAMS_PER_ENDPOINT = 16
export const MAX_FIELDS_PER_ENDPOINT = 64
export const MAX_SOURCE_DESC_CHARS = 300
export const MAX_ENDPOINT_DESC_CHARS = 300

// ── Network security ─────────────────────────────────────────────────────────
// GET is the only verb in the codebase; redirects are never followed so an
// Authorization header can never be forwarded to another origin.
export const REQUEST_METHOD = 'GET'
export const REDIRECT_HINT = 'The source answered with a redirect; redirects are disabled so credentials are never forwarded cross-origin. Point the source at the final URL.'
// Per-request timeout for one HTTP round-trip (source-configurable within bounds).
export const DEFAULT_TIMEOUT_MS = 10_000
export const MIN_TIMEOUT_MS = 500
export const MAX_TIMEOUT_MS = 60_000
// Tool-level budget: a read/snapshot performs at most two round-trips (one
// transparent retry), so this comfortably covers the worst case.
export const TOOL_TIMEOUT_MS = 60_000
export const STATUS_TOOL_TIMEOUT_MS = 30_000
// Hard byte cap on any upstream response body, enforced while streaming. The
// default per source is lower (1 MiB); the admin may raise it up to this ceiling.
export const HARD_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
export const MIN_MAX_RESPONSE_BYTES = 1024
// Statuses worth one transparent retry (idempotent GET).
export const RETRYABLE_STATUS = new Set([502, 503, 504])
export const RETRY_DELAY_MS = 200

// ── Query parameters (agent-supplied, whitelist-validated) ───────────────────
export const QUERY_PARAM_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'enum'])
export const MAX_PARAM_VALUE_CHARS = 256
export const MAX_QUERY_STRING_CHARS = 1024

// ── Field selection & value bounding ─────────────────────────────────────────
// How many field aliases the agent may select (and how many an endpoint may
// define before listing starts truncating).
export const MAX_FIELDS_PER_READ = 32
// Per-value bounds applied while building an observation.
export const MAX_FIELD_VALUE_DEPTH = 24
export const MAX_FIELD_VALUE_ITEMS = 100
export const MAX_FIELD_VALUE_CHARS = 4096
// Total serialized size of the observation `data` object.
export const MAX_DATA_JSON_BYTES = 64 * 1024
export const TRUNCATION_MARK = '[worldsense: truncated]'

// ── Observation metadata ─────────────────────────────────────────────────────
export const MAX_WARNINGS = 8

// ── History ──────────────────────────────────────────────────────────────────
export const DEFAULT_HISTORY_LIMIT = 20
export const MAX_HISTORY_LIMIT = 100

// ── Diff ─────────────────────────────────────────────────────────────────────
export const MAX_DIFF_ENTRIES = 200
export const MAX_DIFF_VALUE_CHARS = 200
export const MAX_DIFF_DEPTH = 32

// ── worldsense_sources listing budget ────────────────────────────────────────
export const MAX_SOURCE_LIST_LINES = 400

// ── Error detail ─────────────────────────────────────────────────────────────
// Upstream bodies are untrusted and may echo credentials; every fragment is
// redacted, single-lined and truncated before it reaches an agent-facing string.
export const ERROR_DETAIL_MAX_CHARS = 300

// ── Snapshot store ───────────────────────────────────────────────────────────
export const DB_SUBDIR = 'worldsense'
export const DB_FILE_NAME = 'worldsense.db'
export const BUSY_TIMEOUT_MS = 5_000
