# Architecture

WorldSense is a read-only perception layer: it turns administrator-configured
JSON APIs into bounded, provenance-carrying observations for a DeepSeek
Harness agent, and nothing else.

```text
                   AI Agent
                       │
                       ▼
                WorldSense Tools          (lib/tools/)
                       │
                       ▼
              Source Resolver            (lib/config.js — admin config, fail-fast)
                       │
             ┌─────────┴─────────┐
             │                   │
      Query Validator      Credential Resolver   (lib/observation.js / lib/runtime.js)
             │                   │
             └─────────┬─────────┘
                       ▼
                HTTP JSON Adapter           (lib/http.js — GET only, no redirects)
                       │
                       ▼
                Remote World API
                       │
                       ▼
                JSON Response
                       │
                       ▼
                 Field Selector            (lib/jsonpointer.js — admin aliases only)
                       │
                       ▼
               Secret Redaction            (lib/redact.js)
                       │
                       ▼
                Response Bounds            (pruning + truncation metadata)
                       │
                       ▼
                WorldObservation           (+ SHA-256 via lib/hash.js)
                       │
                ┌──────┴──────┐
                │             │
              Agent        SQLite          (lib/store.js — local snapshots)
                           Snapshot
```

## Layers and files

| Layer | File | Responsibility |
| --- | --- | --- |
| Composition root | `index.js` | Plugin metadata, settings schema, system-prompt guidance, `apply()`; validates config fail-fast, wires runtime → six tools |
| Bounds & identity | `lib/constants.js` | Every timeout, byte cap, count limit — the auditable security envelope |
| Config | `lib/config.js` | Source/endpoint/query/field normalization + fail-fast validation; source & endpoint resolution; base-URL policy (HTTPS default, loopback/`allowInsecureHttp` exceptions) |
| HTTP | `lib/http.js` | The only network code: GET-only fetch with `redirect:'error'`, per-request timeout, streaming byte cap, origin re-verification, one transparent retry, bounded error translation |
| Observation | `lib/observation.js` | The pipeline: whitelisted params → confined URL → credentials → GET → JSON Pointer selection → pruning → redaction → hash → `WorldObservation` |
| Selection | `lib/jsonpointer.js` | Minimal RFC 6901-style get/validate (no dependency) |
| Redaction | `lib/redact.js` | Sensitive-key walk + credential-pattern scrubbing |
| Identity | `lib/hash.js` | Stable JSON serialization (sorted keys) + SHA-256 content hash |
| Diff | `lib/diff.js` | Deterministic structural diff, bounded entries/values/depth |
| Errors | `lib/failures.js` | `WorldSenseError` with stable codes; sanitized, bounded messages |
| Store | `lib/store.js` | `node:sqlite` snapshot store: migrations, WAL, busy_timeout, parameterized SQL |
| Runtime | `lib/runtime.js` | Multi-source resolution, credential resolution into headers, lazy store handle |
| Tools | `lib/tools/discovery.js` | `worldsense_sources`, `worldsense_status` |
| | `lib/tools/read.js` | `worldsense_read`, `worldsense_snapshot` |
| | `lib/tools/history.js` | `worldsense_history`, `worldsense_diff` |
| Helpers | `lib/util.js` | Bounded IO, text sanitization, timestamps, id generation |

## Plugin entry (`index.js`)

`apply(ctx, config)`:

1. **Validates the whole config fail-fast** (`validateConfig`) — a broken
   config throws before anything is registered, so the plugin never loads
   half-wired. Duplicate ids, unsupported types, bad base URLs, unsafe paths,
   invalid JSON Pointers, invalid query schemas, invalid auth, literal secrets
   and out-of-range limits are all load-time errors.
2. Registers with the settings service when available (resolved settings win;
   otherwise the entry config is the fallback). The runtime holds a config
   *getter*, so settings edits apply on the next call.
3. Creates the runtime with a **lazy** SQLite handle — a bad `dbPath` makes
   snapshot tools error at call time instead of failing the whole plugin load.
   `ctx.effect` closes the connection on unload.
4. Registers one system-prompt guidance section and the six read-only tools.

## The trust boundary

Everything the agent can influence is a *value inside a shape the
administrator defined*:

- `source` → must match a configured source id
- `endpoint` → must match a configured endpoint id
- `params.<name>` → must be a whitelisted parameter, type/range/enum-checked
- `fields[]` → must be configured field aliases (the agent never sees a JSON
  Pointer)

The agent cannot express a URL, host, port, protocol, path, method, header or
credential — these concepts do not exist in any tool schema (asserted by
`test/escape.test.js`).

## The request path, concretely

1. `resolveSource` / `resolveEndpoint` — id lookups, nothing else.
2. `validateParams` — whitelist, types, ranges, enums, defaults; unknown names
   rejected. Query is built with `URLSearchParams` (encoded by construction).
3. `resolveFieldSelection` — alias validation *before* any network side
   effect, so a bad argument fails with zero requests sent.
4. `buildRequestUrl` — `new URL(path, base)`, then **origin re-verification**
   (`url.origin === base.origin`, no embedded userinfo). Belt and braces on
   top of the path grammar validated at config load (no `//`, no `://`, no
   `?`/`#`, percent-decode re-check).
5. `buildHeaders` — credentials resolved from the DSH credential store into
   the auth header. Fixed `accept: application/json` besides; nothing else,
   ever.
6. `fetchJson` — GET (constant), `redirect:'error'`, `AbortSignal.timeout`
   combined with the host signal, streaming byte cap; JSON parsed strictly
   (a 200 with a non-JSON body is `invalid_json`, never success).
7. Selection → pruning → redaction → hashing → observation assembly.

## The observation envelope

```js
{
  source, endpoint, observedAt,
  data: { ...admin-aliased, redacted, bounded values... },
  provenance: { source, endpoint, method: 'GET', url, params },
  contentHash: 'sha256:…',       // over stable-serialized sanitized data
  bytesReceived, latencyMs, httpStatus,
  truncated: false, truncationReasons: [],
  warnings: []                    // e.g. field_not_found:<alias>
}
```

`truncated` is true **only** when WorldSense itself dropped data it held
because of a budget (`field_value_limit`, `field_count_limit`,
`data_byte_limit`, `diff_entry_limit`). A small remote answer is not
truncation, and remote-side pagination is never guessed at — the lesson
dsh-searchops learned, kept here.

## Snapshot store

SQLite via `node:sqlite` (Node builtin ≥ 22.5; zero native deps). Default
location `$DSH_HOME/worldsense/worldsense.db` (`~/.dsh/worldsense/…` by
default); `dbPath` config supports absolute, `~/` and in-data-dir relative
paths. WAL + `busy_timeout=5000` + `synchronous=NORMAL`. Schema version in
`PRAGMA user_version`; migrations are append-only and transactional. All SQL
is parameterized — identifiers never come from outside.

Only sanitized observations are persisted. `data_json` is the stable
serialization of the redacted, bounded `data`; `metadata_json` carries
provenance, warnings, truncation reasons and byte/latency accounting.

## Diff

`diffJson(before, after)` walks both trees: objects by key (sorted —
deterministic), arrays by index, scalars by stable-JSON equality. Type
mismatches collapse into one `changed` entry. Bounds: 200 entries total, 200
chars per rendered value, depth 32 — exceeded means `truncated: true` plus
`diff_entry_limit`, never a context bomb. Equal content hashes short-circuit
to an empty diff.

## Testing strategy

118 tests, fully offline (fetch mocked at the `globalThis` boundary, the
credential store is a map, the SQLite store runs in throwaway temp dirs):

- `config.test.js` — validation & canonicalization matrix
- `escape.test.js` — **the security core**: no escape-hatch parameters; hostile
  params/ids/aliases never move the destination; GET-with-`redirect:error` on
  every observed request
- `http.test.js` — redirects, timeouts, byte budget, invalid JSON, error
  translation, retry
- `observation.test.js` — selection, graceful missing fields, bounding,
  truncation semantics, provenance
- `redact.test.js` — the redaction matrix, end-to-end into snapshots
- `hash.test.js` / `diff.test.js` — determinism and bounds
- `store.test.js` — persistence, migration, filters, SQL-injection-shaped
  payloads, 50 concurrent writes
- `tools.test.js` — the six tools end-to-end incl. credential isolation
- `plugin.test.js` — metadata, registration, guidance, secure defaults
- `unicode.test.js` — 中文 / 日本語 / emoji through the whole pipeline

## Relationship to other DSH plugins

- `dsh-grafana` — observability domain (metrics, dashboards, alerts,
  Prometheus, Loki). Dedicated plugin.
- `dsh-searchops` — logs, search, events, trace evidence, investigation.
  Dedicated plugin.
- `dsh-worldsense` (this plugin) — the generic long tail: any structured
  status API an administrator wants the agent to see. No adapter for Grafana
  or SearchOps exists here, by design — if a domain deserves a plugin, it
  gets its own.
- `dsh-human-intent` (sibling, separate repo) — the mirror image: humans
  authorize how the agent changes the world. WorldSense is read-only and
  never authorizes writes.
