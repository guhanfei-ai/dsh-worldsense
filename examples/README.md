# Examples

Everything here is fully local: no external API, no real credentials.

## One-command demo

```bash
npm run demo
```

Starts a local JSON API (`demo-server.mjs`) on an ephemeral loopback port,
loads the real plugin, and walks the full v0.1 evidence workflow:

```
worldsense_sources → worldsense_read → worldsense_snapshot
→ (the world changes) → worldsense_snapshot → worldsense_history → worldsense_diff
```

Snapshots go to a throwaway temp directory; nothing is left behind.

## Standalone demo server

Run the demo "world" by hand and point your own config at it:

```bash
node examples/demo-server.mjs --port 8919
```

- `GET /api/status` — payment-api deployment state (requires `Authorization: Bearer demo-token`)
- `GET /api/release` — release channel info
- The state lives in `examples/demo-state.json`; edit the file, read again, and the change shows up. Diff two snapshots around an edit to see worldsense_diff in action.

## Configuration example

[`config.example.json`](./config.example.json) shows four administrator-defined
sources: an internal platform with an API-key header, a GitHub repository with
bearer auth, an unauthenticated business API, and a loopback dev service. See
[docs/SOURCE_CONFIG.md](../docs/SOURCE_CONFIG.md) for the full schema.
