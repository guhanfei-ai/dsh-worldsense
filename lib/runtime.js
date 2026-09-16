// lib/runtime.js — Stateful infrastructure: multi-source resolution, credential
// resolution into request headers, the observation pipeline and the lazy
// snapshot store. Everything downstream (tools) goes through this object.
//
// Credential isolation invariants enforced here:
//   • Secret values are resolved from the DSH credential store per request and
//     go straight into the Authorization / API-key header. They are never
//     returned, logged, hashed, persisted or interpolated into an error.
//   • Errors about missing credentials mention the *reference*, never a value.
import { AUTH_API_KEY_HEADER, AUTH_BASIC, AUTH_BEARER } from './constants.js'
import { effectiveSources, sanitizeBaseUrlForDisplay } from './config.js'
import { CODES, fail } from './failures.js'

function base64(input) {
  const str = String(input ?? '')
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64')
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)))
  throw new Error('No base64 encoder available in this runtime.')
}

export function createRuntime(ctx, activeConfig, storeHandle) {
  function config() {
    return activeConfig() ?? {}
  }

  // ── Credentials ────────────────────────────────────────────────────────────

  // Resolve a credential value by ref; '' when unset. The value is a secret:
  // callers may only use it to build a header, never a message.
  async function resolveCredential(ref) {
    if (!ref) return ''
    try {
      const result = await ctx.credentials.resolve(ref)
      return typeof result?.value === 'string' ? result.value : ''
    } catch {
      return ''
    }
  }

  async function credentialPresent(ref) {
    return Boolean(await resolveCredential(ref))
  }

  // Build the auth headers for a source. Throws credential_unavailable with the
  // ref name (never a value) when a required secret is missing.
  async function buildHeaders(source) {
    const auth = source.auth
    if (auth.type === AUTH_BEARER) {
      const token = await resolveCredential(auth.credentialRef)
      if (!token) {
        throw fail(CODES.CREDENTIAL_UNAVAILABLE, `credential_unavailable: bearer auth for source ${JSON.stringify(source.id)} needs a token. Store it in the DSH credential store under ref ${auth.credentialRef}.`)
      }
      return { accept: 'application/json', authorization: `Bearer ${token}` }
    }
    if (auth.type === AUTH_API_KEY_HEADER) {
      const key = await resolveCredential(auth.credentialRef)
      if (!key) {
        throw fail(CODES.CREDENTIAL_UNAVAILABLE, `credential_unavailable: api-key-header auth for source ${JSON.stringify(source.id)} needs a key. Store it in the DSH credential store under ref ${auth.credentialRef}.`)
      }
      return { accept: 'application/json', [auth.header]: key }
    }
    if (auth.type === AUTH_BASIC) {
      const username = auth.username || (await resolveCredential(auth.usernameRef))
      const password = await resolveCredential(auth.passwordRef)
      if (!username || !password) {
        throw fail(CODES.CREDENTIAL_UNAVAILABLE, `credential_unavailable: basic auth for source ${JSON.stringify(source.id)} needs a username and password. Store them in the DSH credential store under refs ${auth.usernameRef} / ${auth.passwordRef}.`)
      }
      return { accept: 'application/json', authorization: `Basic ${base64(`${username}:${password}`)}` }
    }
    return { accept: 'application/json' }
  }

  // Non-secret source descriptions for worldsense_sources: credentials appear
  // only as a boolean (configured/missing), never as a value or even a ref.
  async function listSources() {
    const sources = effectiveSources(config())
    const out = []
    for (const source of sources) {
      let credentialsConfigured = true
      if (source.auth.type === AUTH_BEARER || source.auth.type === AUTH_API_KEY_HEADER) {
        credentialsConfigured = await credentialPresent(source.auth.credentialRef)
      } else if (source.auth.type === AUTH_BASIC) {
        const haveUser = Boolean(source.auth.username) || (await credentialPresent(source.auth.usernameRef))
        const havePass = await credentialPresent(source.auth.passwordRef)
        credentialsConfigured = haveUser && havePass
      }
      out.push({
        id: source.id,
        name: source.name,
        description: source.description,
        type: source.type,
        baseUrl: sanitizeBaseUrlForDisplay(source.baseUrl),
        auth: source.auth.type,
        credentialsConfigured,
        endpoints: source.endpoints.map((endpoint) => ({
          id: endpoint.id,
          description: endpoint.description,
          path: endpoint.path,
          params: Object.entries(endpoint.query).map(([name, spec]) => ({
            name,
            type: spec.type,
            required: spec.required,
            ...(spec.values ? { values: spec.values } : {}),
            ...(spec.min !== undefined ? { min: spec.min } : {}),
            ...(spec.max !== undefined ? { max: spec.max } : {}),
            ...(spec.default !== undefined ? { default: spec.default } : {}),
          })),
          fields: endpoint.fields.map((field) => field.alias),
        })),
      })
    }
    return out
  }

  // Lazy store accessor: opens (and migrates) the SQLite file on first use.
  function store() {
    return storeHandle.ensure()
  }

  return { config, resolveCredential, credentialPresent, buildHeaders, listSources, store }
}
