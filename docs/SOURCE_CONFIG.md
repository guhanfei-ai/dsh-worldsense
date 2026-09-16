# Source Configuration

Sources are the trust boundary: everything the agent can reach is defined
here, by an administrator. Config lives in Settings → Plugins (array form) or
in hand-written JSON (map forms below; both are canonicalized). It is
validated **fail-fast at plugin load** — an invalid config registers nothing.

```jsonc
{
  "sources": [ /* see below */ ],
  "allowInsecureHttp": false,
  "dbPath": ""
}
```

| Top-level | Type | Default | Meaning |
| --- | --- | --- | --- |
| `sources` | array (or map) of source objects | `[]` | The windows into the world. Max 50. |
| `allowInsecureHttp` | boolean | `false` | Allow plain `http://` for non-loopback hosts (see HTTP policy). Loopback is always allowed. |
| `dbPath` | string | `""` | SQLite snapshot file. Empty → `$DSH_HOME/worldsense/worldsense.db` (`~/.dsh/worldsense/worldsense.db` by default). `~/` expands; a relative path resolves inside the plugin data directory. |

## Source object

```jsonc
{
  "id": "prod-platform",              // required, unique, ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$
  "name": "Production Platform",      // optional display name (defaults to id)
  "description": "Payment platform status API",
  "type": "http-json",                // only "http-json" in v0.1

  "baseUrl": "https://platform.internal.example.com",
  "allowInsecureHttp": false,         // per-source override of the global flag

  "auth": { /* see below */ },

  "timeoutMs": 5000,                  // per-request timeout, 500–60000, default 10000
  "maxResponseBytes": 262144,         // response byte cap, 1024–4194304, default 1048576

  "endpoints": { /* map or array, see below */ }
}
```

**Rules enforced at load time**

- `id` unique across all sources; no surrounding whitespace (that is a
  mistake worth surfacing, not silently normalizing)
- `baseUrl`: absolute `https://` (or `http://` for loopback / with
  `allowInsecureHttp`), no embedded credentials, no query string, no fragment
- literal secrets (`password`, `token`, `secret`, `apiKey`, `api_key`,
  `authorization`, `credential`) anywhere in a source object are **rejected**
  with a pointer to the credential store — they must never reach Git
- `timeoutMs` integer in `[500, 60000]`; `maxResponseBytes` integer in
  `[1024, 4194304]`

## Auth

Four modes. `credential`/`credentialRef` is always a **credential-store
reference** (letters, digits, underscore, leading letter/underscore) — never
a secret value.

```jsonc
// no auth (open or network-protected API)
{ "type": "none" }

// bearer token → Authorization: Bearer <secret>
{ "type": "bearer", "credential": "GITHUB_TOKEN" }
// ref defaults to WORLDSENSE_TOKEN_<id> when omitted

// API key in a header chosen by the ADMINISTRATOR (agent can never set it)
{ "type": "api-key-header", "header": "X-API-Key", "credential": "PLATFORM_API_KEY" }
// header defaults to X-API-Key; ^[A-Za-z0-9-]{1,64}$

// HTTP basic; username may be non-secret config, both secrets via refs
{ "type": "basic", "username": "svc-agent", "usernameRef": "PLATFORM_USER", "passwordRef": "PLATFORM_PASS" }
// refs default to WORLDSENSE_USERNAME_<id> / WORLDSENSE_PASSWORD_<id>
```

Missing credentials fail at call time with `credential_unavailable` naming
the ref — never a value — and no request is sent.

## Endpoints

Map form (endpoint id → definition) or array form (`{ "id": …, … }`); max 50
per source, ids unique per source (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`).

```jsonc
"deployment-status": {
  "description": "Current deployment state of payment-api",
  "path": "/api/v1/deployments/payment-api",

  "query": {
    "environment": { "type": "enum", "values": ["prod", "staging"], "required": true },
    "limit":       { "type": "integer", "min": 1, "max": 100, "default": 20 },
    "verbose":     { "type": "boolean", "default": false },
    "ratio":       { "type": "number", "min": 0, "max": 1 },
    "note":        { "type": "string", "maxLength": 64 }
  },

  "fields": {
    "service":         "/service",                        // shorthand: alias → pointer
    "version":         { "pointer": "/version" },          // object form
    "desiredReplicas": { "pointer": "/replicas/desired", "required": true }
  }
}
```

### `path` — a fixed relative path

- must start with `/`, max 512 chars
- never: absolute URLs, `//…` (protocol-relative), `://`, `\`, `?`, `#`,
  control characters, characters outside a conservative allow-list; percent
  escapes are fine but the **decoded** form must also be safe (`%2f%2f` runs
  are rejected)
- at request time the resolved origin is re-verified against `baseUrl`'s
  origin — a path can never smuggle the request to another host
- v0.1 has **no interpolation** (`/repos/{owner}/{repo}` is a future idea).
  Need several resources? Configure several endpoints.

### `query` — the whitelist

- max 16 parameters per endpoint, names
  `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`, unique
- types: `string` | `integer` | `number` | `boolean` | `enum`
  - `string`: optional `maxLength` (≤ 256, the default)
  - `integer`/`number`: optional `min` / `max` (validated `min ≤ max`;
    defaults are checked against them too)
  - `enum`: non-empty unique `values` (≤ 32)
- `required: true` or `default: <value>` per parameter
- the agent may pass **only** these names with values passing exactly these
  constraints; unknown names, wrong types, out-of-range values, control
  characters → `invalid_parameter`. The query string is built with
  `URLSearchParams` — values are encoded by construction and can never
  restructure the URL.
- no expression language, no wildcards, no `*` semantics

### `fields` — the visible projection

- map of alias → JSON Pointer (RFC 6901 style, e.g. `/status`,
  `/health/ok`, `/releases/0/version`; `~0`/`~1` escaping supported);
  1–64 aliases per endpoint, unique
- aliases: `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$` — they become the keys of
  the observation's `data`
- `required: true` (object form): a missing pointer fails the observation
  with `field_not_found`; default behavior is graceful degradation with a
  `field_not_found:<alias>` warning
- pointers that route **through** a sensitive key (e.g. `/db/password`) are
  redacted at the redaction boundary regardless of the alias name
- the agent can select a subset of aliases in `worldsense_read`/
  `worldsense_snapshot` (`fields: ["version", "readyReplicas"]`), never an
  arbitrary pointer, and never more than 32 per read

## HTTP policy, in short

- HTTPS by default; `http://` free for loopback (`localhost`, `127.0.0.1`,
  `::1`), explicit opt-in elsewhere (`allowInsecureHttp`, per source or
  global)
- internal/private networks (RFC1918, internal DNS) are **allowed** — the
  administrator choosing the destination *is* the SSRF boundary; the agent
  never chooses addresses
- GET only (structural), redirects never followed, every response
  byte-capped while streaming, every request timed

## Complete example

See [examples/config.example.json](../examples/config.example.json) for four
fully-worked sources: api-key-header internal platform, bearer GitHub,
no-auth business API, loopback dev service.

## What gets stored

Snapshots persist **only** the sanitized observation (selected fields, after
redaction and bounding) plus provenance/metadata — never credentials, auth
headers, cookies, request headers or raw upstream bodies. The database file
is local to the machine and should stay out of backups you don't control;
it is gitignored by default.
