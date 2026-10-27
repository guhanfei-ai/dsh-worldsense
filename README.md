# dsh-worldsense

> [!NOTE]
> 🧪 **Experimental.** An early prototype from the [guhanfei-ai](https://github.com/guhanfei-ai) lab: the idea is serious, the code is a first cut. There is no stable release yet; APIs, data formats and behavior may change without notice, so it is not recommended for production. Ideas and issues are welcome.

> **WorldSense lets DeepSeek Harness safely read administrator-defined JSON
> APIs without turning the agent into an unrestricted HTTP client.**
>
> 给 DSH Agent 一个安全、只读、受限的"现实感知层"。

A safe, bounded, read-only perception layer for AI agents. Agents choose what
configured source to observe. They do not choose where arbitrary network
requests go.

```text
World → AI  = WorldSense   (this plugin: the agent observes the world)
AI → World  = Human Intent (a sibling plugin: humans authorize changes)
```

核心口号：**Give AI the ability to read the world.**

中文说法：管理员定义"世界有哪些窗口"；Agent 决定"现在看哪个窗口"；
Agent 不能自己在墙上再开一个洞。

---

## What it is

WorldSense gives a DeepSeek Harness (DSH) agent six read-only tools for
observing **generic structured world state** — the long tail of JSON APIs that
are worth reading but not worth a dedicated plugin:

deployment APIs, feature-flag state, service registries, status pages, GitHub
project stats, release info, CI status, queue depth, inventory, internal
platform state, cloud control-plane read APIs, business numbers, any custom
JSON API (v0.1: **GET + JSON only**).

If a system deserves a dedicated plugin (metrics/dashboards/alerts →
`dsh-grafana`; logs/search/trace evidence → `dsh-searchops`), use the
dedicated plugin. If you just want the agent to **safely read one structured
status API**, that is WorldSense's job.

### 中文定位

WorldSense 给 DSH Agent 一个读取现实世界状态的通用感知层：

- **安全（safe）**—— 目的地由管理员配置，Agent 永远无法指定任意 URL、主机、端口、协议、路径、HTTP 方法、Header 或凭证。
- **受限（bounded）**—— 每一层都有预算：响应字节数、字段数量、值长度、diff 条目数、历史条数；超限永远如实标注 `truncated`。
- **可追溯（traceable）**—— 每次读取都是一个带来源（provenance）的 `WorldObservation`：source、endpoint、GET url、observedAt、SHA-256 contentHash。

## Why not just curl?

Three questions this plugin exists to answer:

**Why can't the agent fetch any URL?** An agent with an arbitrary-URL tool is
an unauthenticated proxy that can be steered anywhere — including localhost
admin panels, cloud metadata endpoints, and internal services — by prompt
injection in any text it reads. SSRF is not a hypothetical for an agent
runtime; it is the default behavior of "give the model a fetch tool". In
WorldSense the agent only ever names a **source id** and an **endpoint id**;
the destination is resolved from administrator configuration, and the resolved
URL's origin is re-verified against the configured origin on every request.

**Why admin-defined sources?** Because the trust boundary has to live
somewhere. The administrator decides which windows into the world exist
(base URL, fixed paths, whitelisted query parameters, named field aliases,
auth mode). The agent decides which window to look through, right now. The
agent never gets to punch a new hole in the wall — there is no tool parameter
for a URL, host, port, protocol, path, method, header or credential, and the
test suite enforces that structurally.

**Why snapshots and provenance?** Because evidence without provenance is weak
evidence. Every observation carries its source, endpoint, observation time and
a deterministic SHA-256 content hash; `worldsense_snapshot` saves the
sanitized observation to local SQLite, and `worldsense_diff` computes a
deterministic structural diff between two snapshots — so "what changed since
yesterday" is a plugin computation, not something the LLM eyeballs. Observation
≠ truth (see [docs/EVIDENCE_MODEL.md](docs/EVIDENCE_MODEL.md)): the remote API
may be stale, wrong, partial or malicious, and WorldSense never hides that.

## The six tools (v0.1)

| Tool | What it does |
| --- | --- |
| `worldsense_sources` | List configured sources/endpoints/params/field aliases (no secrets) |
| `worldsense_status` | Reachability, latency, HTTP status of one source endpoint (no body) |
| `worldsense_read` | Observe now → one bounded `WorldObservation` (nothing persisted) |
| `worldsense_snapshot` | Observe now + save sanitized result to local SQLite, returns `snapshotId` |
| `worldsense_history` | Bounded metadata listing of saved snapshots (filters: source, endpoint, before/after) |
| `worldsense_diff` | Deterministic structural JSON diff between two snapshot ids |

All of them are strictly read-only towards the outside world: the HTTP client
is GET-only **by construction** (the method is a constant in the code; no
config, argument or internal path can change it), redirects are never
followed, and every response is byte-capped while streaming.

## Quick start

```bash
npm install
npm test        # 118 tests, fully offline
npm run demo    # local end-to-end demo: read → snapshot → change → snapshot → diff
```

Configure sources in Settings → Plugins (or hand-write JSON — both forms are
canonicalized):

```json
{
  "sources": [
    {
      "id": "github-dsh-grafana",
      "type": "http-json",
      "baseUrl": "https://api.github.com",
      "auth": { "type": "bearer", "credential": "GITHUB_TOKEN" },
      "endpoints": {
        "repository": {
          "path": "/repos/guhanfei-ai/dsh-grafana",
          "fields": {
            "stars": "/stargazers_count",
            "forks": "/forks_count",
            "issues": "/open_issues_count",
            "updatedAt": "/updated_at"
          }
        }
      }
    }
  ]
}
```

`auth.credential` is a **credential-store reference**, never a secret value —
the token itself lives in the DSH credential store and is resolved at request
time, going straight into the Authorization header: never into tool output,
errors, logs, snapshots or the database.

Full schema: [docs/SOURCE_CONFIG.md](docs/SOURCE_CONFIG.md) · runnable
examples: [examples/](examples/).

## Three real scenarios

### A — Deployment state

Source `prod-platform`, endpoint `deployment-status` →
`service=payment-api, version=1.8.4, replicas=12, healthy=12`.
The agent can answer *"what version is payment-api running in production
right now?"* — with a content hash and an observation time attached.

### B — GitHub reality feedback

Source `github-dsh-grafana`, endpoint `repository` →
`stars, forks, issues, updatedAt`. *"What real-world feedback does the project
have right now?"* One generic JSON adapter — no dedicated GitHub plugin, no
browser, no scraping.

### C — Internal business state

Source `business-api`, endpoint `daily-summary` →
`orders, revenue, failedPayments, activeUsers`. The agent observes business
reality through the same confined pipeline as everything else.

## Design philosophy

```text
Connectivity ≠ Permission        Data ≠ Evidence        Evidence ≠ Truth
```

```text
World → Configured Source → Bounded Observation → Provenance → Evidence → Agent Reasoning
```

WorldSense does the deterministic work — fetch, validate, select, redact,
bound, hash, persist, diff. The model does the reasoning — understand, explain,
decide what to inspect next. The plugin never judges: it reports
`readyReplicas=8, desiredReplicas=10` and lets the agent conclude; it never
calls another LLM, never summarizes via AI, never performs "AI root-cause
analysis". **WorldSense = deterministic perception. LLM = reasoning.**

And in the wider picture (deliberately decoupled repos, complementary ideas):

```text
WorldSense answers:  "What may the agent observe?"
Human Intent answers: "What may the agent change?"
```

```text
        WORLD
          │
          ▼
     WorldSense
          │
          ▼
        Agent
          │
    proposed action
          │
          ▼
    Human Intent
          │
          ▼
        Human
          │
    authorization
          │
          ▼
        WORLD
```

WorldSense **does not authorize write actions** — writes belong to Human
Intent.

## Honest non-guarantees

- WorldSense cannot guarantee detection of every secret (redaction is a
  best-effort key/pattern heuristic, not a DLP product).
- WorldSense does not make an untrusted API trustworthy.
- WorldSense does not prevent malicious content from appearing inside
  otherwise allowed data (treat remote content as untrusted data).
- WorldSense does not provide complete prompt-injection protection.
- WorldSense does not provide distributed snapshot consistency (snapshots are
  local observations, not a consensus log).
- WorldSense does not authorize write actions.

Details: [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the pipeline, layer by layer
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and the security envelope
- [docs/EVIDENCE_MODEL.md](docs/EVIDENCE_MODEL.md) — observations, snapshots, hashes, diffs, freshness
- [docs/SOURCE_CONFIG.md](docs/SOURCE_CONFIG.md) — the full source configuration schema
- [examples/](examples/) — local demo (no credentials, no network)

## Future ideas (explicitly NOT in v0.1)

More source adapters (HTML, GraphQL, RSS/XML, WebSocket/SSE), path
interpolation (`/repos/{owner}/{repo}`), POST/other verbs (behind Human
Intent-style approval), cross-source observation, world state graph, evidence
correlation, plugin interoperability, Grafana/SearchOps adapters, browsers,
MCP aggregation, AI summaries, a sidebar dashboard, vector search. None of
these exist today — v0.1 is deliberately one adapter deep instead of ten
adapters shallow.

## Development

```bash
npm run verify   # check (syntax gate) + the full offline test suite
```

Requires Node ≥ 22.5 (the snapshot store uses the built-in `node:sqlite`;
zero native dependencies). MIT License.

## 与中文读者说一句

WorldSense 的全部安全设计可以压缩成三句话：

> 管理员定义墙上的窗户在哪里；Agent 决定现在看哪一扇窗；Agent 永远不能自己在墙上打洞。

所有边界（目的地限制、GET-only、禁止重定向、凭证隔离、响应预算、
best-effort 脱敏）都在代码结构里，由测试锁死，而不只是写在文档里。
