// examples/demo-server.mjs — A fully local demo "world": a tiny read-only JSON
// API standing in for a deployment/business platform. No external network, no
// real credentials. The payload it serves deliberately includes a
// sensitive-looking section so you can watch WorldSense's redaction boundary
// work (the selected fields never include it — and if an admin mis-configures a
// pointer into it, it still comes back as [REDACTED]).
//
// CLI:  node examples/demo-server.mjs [--port 8919] [--state ./demo-state.json]
// Lib:  import { startDemoServer } from './demo-server.mjs'
//
// Endpoints (all GET, JSON):
//   /api/status   → payment-api deployment state, read fresh from the state file
//   /api/release  → current release channel info
// Auth: Authorization: Bearer demo-token  (else 401)

import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEMO_TOKEN = 'demo-token'
export const DEFAULT_STATE_FILE = join(HERE, 'demo-state.json')

export function defaultState() {
  return {
    service: 'payment-api',
    version: '1.4.2',
    healthy: true,
    replicas: { desired: 10, ready: 10 },
    queue: { depth: 3 },
    // Sensitive noise a real-world API might echo back. WorldSense redacts it.
    secrets: { password: 'not-a-real-secret', token: 'neither-is-this' },
  }
}

export function loadState(stateFile) {
  try {
    if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    // fall through to the default state
  }
  return defaultState()
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function startDemoServer({ port = 0, stateFile = DEFAULT_STATE_FILE, token = DEMO_TOKEN } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'read-only demo: GET only' })
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      sendJson(res, 401, { error: 'missing or invalid Authorization (the demo token is "demo-token")' })
      return
    }
    const state = loadState(stateFile)
    if (url.pathname === '/api/status') {
      sendJson(res, 200, state)
      return
    }
    if (url.pathname === '/api/release') {
      sendJson(res, 200, { version: state.version, channel: 'stable' })
      return
    }
    sendJson(res, 404, { error: `no such endpoint: ${url.pathname}` })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actualPort } = server.address()
      resolve({
        server,
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

// ── CLI mode ─────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const port = Number(flag('port', '8919'))
  const stateFile = flag('state', DEFAULT_STATE_FILE)
  startDemoServer({ port, stateFile }).then((demo) => {
    console.log(`worldsense demo world listening on ${demo.url}`)
    console.log(`  GET /api/status   (Authorization: Bearer ${DEMO_TOKEN})`)
    console.log(`  GET /api/release`)
    console.log(`state file: ${stateFile} (edit it, then read again to see change)`)
  })
}
