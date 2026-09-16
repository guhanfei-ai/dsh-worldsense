# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-17

First release: a safe, bounded, read-only perception layer for DeepSeek
Harness agents.

### Added

- **Source model**: administrator-defined `http-json` sources (id, name,
  description, base URL, auth, timeout, response byte cap) with fixed
  endpoints (relative path only), whitelisted query parameters
  (string/integer/number/boolean/enum with min/max/required/default) and
  field aliases bound to RFC 6901-style JSON Pointers. Fail-fast config
  validation at plugin load (duplicate ids, unsafe paths, bad URLs, invalid
  pointers/query schemas/auth, literal secrets rejected outright).
- **Security envelope**: GET-only HTTP client (method is a constant — no
  config, argument or internal path can change it), redirects never followed
  (`redirect: 'error'` plus 3xx-response refusal), per-request timeouts,
  streaming response byte caps (default 1 MiB, hard 4 MiB), origin
  re-verification on every request, HTTPS-by-default with explicit
  `allowInsecureHttp` for non-loopback hosts, credential isolation via the
  DSH credential store (refs only in config; values never reach output,
  errors, logs, snapshots or the database), best-effort secret redaction
  (sensitive-key walk + credential-pattern scrubbing + pointer-through guard).
- **Six read-only tools**: `worldsense_sources`, `worldsense_status`,
  `worldsense_read`, `worldsense_snapshot`, `worldsense_history`,
  `worldsense_diff`.
- **Evidence model**: `WorldObservation` with provenance (source, endpoint,
  GET url, params, observedAt), deterministic SHA-256 content hash over
  stable-serialized (key-sorted) sanitized data, honest truncation semantics
  (`truncated` only ever means a WorldSense budget dropped data).
- **Snapshot store**: local SQLite via `node:sqlite` (zero native
  dependencies), WAL + busy_timeout, `PRAGMA user_version` migrations,
  parameterized SQL only, lazy open with close-on-unload; default
  `$DSH_HOME/worldsense/worldsense.db`.
- **Deterministic diff**: structural JSON diff (objects by key, arrays by
  index) bounded to 200 entries / 200-char values / depth 32, with
  identical-hash short-circuit.
- **Bounded error model**: stable codes (`source_not_found`,
  `invalid_parameter`, `credential_unavailable`, `request_timeout`,
  `redirect_denied`, `response_too_large`, `invalid_json`, `http_error`,
  `snapshot_not_found`, …) with sanitized, redacted, length-capped messages.
- **Local demo** (`npm run demo`): loopback JSON API + full
  read → snapshot → change → snapshot → history → diff walkthrough; no
  external network, no real credentials.
- **Tests**: 118 offline tests covering the escape-prevention core (hostile
  params/ids/aliases can never move the destination), redirects, timeouts,
  response budgets, field selection, graceful missing fields, redaction
  end-to-end into the database, hash/diff determinism and bounds, SQLite
  persistence/migration/concurrency, unicode (中文 / 日本語 / emoji).
- **Docs**: README (EN + zh-CN), ARCHITECTURE, SECURITY (threat model +
  explicit non-guarantees), EVIDENCE_MODEL, SOURCE_CONFIG.

### Non-goals (deliberately out of scope for v0.1)

POST/PUT/PATCH/DELETE, GraphQL, HTML scraping, browsers, RSS/XML,
WebSocket/SSE, gRPC/Kafka/MQTT, SQL, filesystem/shell access, MCP
aggregation, adapters for other DSH plugins, cross-source observation, world
graphs, vector search, AI summaries, sidebar dashboards, path interpolation.
Write actions belong to `dsh-human-intent`, never here.
