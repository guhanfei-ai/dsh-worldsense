# Security Model

WorldSense's single most important property: **it must never become a
model-controlled arbitrary HTTP proxy.** Everything below exists to enforce
that.

```text
Administrators define where the windows are.
Agents decide which window to look through.
Agents do not get to punch arbitrary holes in the wall.
```

## Threat model

| Actor | Trust level | Why |
| --- | --- | --- |
| The agent / LLM | **untrusted requester** | The model may be steered by prompt injection in any text it reads. It must not be able to choose destinations, methods, headers or credentials — not by argument, not by trickery. |
| Administrator configuration | **the trust boundary** | Sources, endpoints, whitelisted params, field aliases, auth modes and limits are defined here and validated fail-fast at load. |
| Remote API responses | **untrusted data** | Bodies may be stale, wrong, partial, huge, or malicious — including echoing credentials or containing injection attempts. Bounded, redacted, never executed. |

WorldSense is responsible for:

- **destination confinement** — the agent can only name configured
  source/endpoint ids; the resolved URL's origin is re-verified against the
  configured origin on every request
- **credential isolation** — secrets live in the DSH credential store, are
  resolved at request time, go straight into the auth header, and never
  appear in tool output, errors, logs, snapshots or the database
- **GET-only enforcement** — the HTTP method is a constant; there is no code
  path that can set another verb or send a body
- **redirect prevention** — `redirect: 'error'` at the fetch layer; a 3xx
  response object is refused, never followed, so credentials are never
  forwarded cross-origin
- **query validation** — whitelist by name, type, range, enum and length;
  unknown parameters are rejected; the query string is built with
  `URLSearchParams` (encoded by construction)
- **bounded responses** — per-request timeout; response byte cap enforced
  *while streaming*; per-value depth/item/length pruning; bounded warnings,
  history pages and diff entries, all with honest truncation flags
- **best-effort secret redaction** — sensitive-key walk + credential-pattern
  scrubbing before anything reaches a result, snapshot or log line

## The confinement chain

An endpoint path must survive all of these before any request exists:

1. **Config load**: relative path starting with `/`; no `//` prefix, no
   `://`, no `\`, no `?`/`#`, no control characters; character allow-list;
   percent-decode re-check (a `%2f%2f` run must not decode into `//`);
   resolution check against a synthetic base.
2. **Request time**: `new URL(path, baseUrl)`; the resolved origin must equal
   the configured base origin; no embedded userinfo. Violations throw
   `configuration_invalid` — the request never happens.

The agent influences **values inside admin-defined shapes only**:

```text
source    → configured source id
endpoint  → configured endpoint id
params.*  → whitelisted (name, type, range, enum, length)
fields[]  → configured aliases (never raw JSON Pointers)
```

There is no tool parameter for `url`, `host`, `port`, `protocol`, `path`,
`method`, `headers` or `credentials` — structurally asserted in
`test/escape.test.js`, which also fires hostile values (`https://evil.com`,
`//evil.com`, `../…`, overlong strings, unknown names, pointer-looking
aliases) through the real tools and verifies the mocked transport only ever
sees the configured origin, with method GET and `redirect: 'error'`.

## HTTP policy

- **HTTPS by default.** Plain `http://` is allowed for loopback hosts always
  (localhost development is legitimate), and for non-loopback hosts only when
  the administrator explicitly sets `allowInsecureHttp` (per-source or
  globally).
- **Internal/private networks are NOT blocked.** WorldSense may legitimately
  read enterprise-internal APIs — RFC1918 hosts, internal DNS — because the
  *administrator chooses the destination*, and that is the entire SSRF
  boundary. The agent cannot choose these addresses; that is the point.
- **Timeouts**: per-source `timeoutMs` (500 ms – 60 s, default 10 s), always
  combined with the host's abort signal.
- **Byte cap**: per-source `maxResponseBytes` (1 KiB – 4 MiB, default 1 MiB),
  enforced while streaming — a multi-gigabyte answer is abandoned the moment
  it crosses the line, and an advertised `content-length` is an early reject.

## Credential handling

- Config holds only credential **references** (`auth.credential` /
  `credentialRef` / derived `WORLDSENSE_*_<sourceId>` refs). Literal secrets
  anywhere in source config are **rejected at load** with a pointed error.
- Values resolve from the DSH credential store per request and go straight
  into `Authorization` (bearer/basic) or the configured API-key header.
- Missing credentials surface as `credential_unavailable` naming the **ref**
  — never a value — and the request is never sent.
- Error paths are redacted and bounded: upstream bodies that echo
  `Authorization: Bearer …` come back as `[REDACTED]` fragments, capped at
  300 characters, single-lined.

## Secret redaction (best-effort, honestly bounded)

Applied to every selected field value (and defensively to error strings)
before it reaches a tool result, a snapshot or a log line:

- **Sensitive keys** (case-insensitive, separator-insensitive): password,
  passwd, pwd, secret, client_secret, token, access_token, refresh_token,
  id_token, api_key/apiKey, api_secret, authorization, proxy-authorization,
  cookie, set-cookie, credential, private_key → value replaced with
  `[REDACTED]`, at any nesting depth, inside arrays too.
- **Pointer guard**: if an admin-configured JSON Pointer selects *through* a
  sensitive key (e.g. alias `conn` → `/db/password`), the whole value is
  redacted even though the alias itself is innocent.
- **Pattern scrubbing** inside ordinary strings: `Bearer …` / `Basic …`
  shapes, `password=…`-style assignments, `sk-…` keys.

**This is not a DLP product.** It is a deterministic heuristic over common
key names and credential shapes. A secret stored under an innocent key
(`"note": "…"`), or a novel token format, can pass through. Administrators
should still choose field aliases that select exactly what the agent needs —
nothing more.

## What WorldSense does NOT guarantee

- **It cannot guarantee detection of every secret** (see above).
- **It does not make an untrusted API trustworthy.** Data can be wrong, stale
  or manipulated upstream.
- **It does not prevent malicious content from appearing inside otherwise
  allowed data.** A status value can contain instructions; the system prompt
  tells the model to treat remote content as untrusted data, but no technical
  boundary here sanitizes semantics.
- **It does not provide complete prompt-injection protection.** No tool that
  returns outside text can promise that.
- **It does not provide distributed snapshot consistency.** Snapshots are
  local, point-in-time observations — not a consensus log.
- **It does not authorize write actions.** There is no write path — towards
  remote systems (GET only, structurally) or local state (snapshots are
  append-only local records). Writes belong to `dsh-human-intent`.

## Reporting

Security issues: open an issue at
[github.com/guhanfei-ai/dsh-worldsense/issues](https://github.com/guhanfei-ai/dsh-worldsense/issues).
