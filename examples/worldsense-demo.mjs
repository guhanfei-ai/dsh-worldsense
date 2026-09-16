// examples/worldsense-demo.mjs — A complete, fully local demo of the v0.1
// workflow, no real credentials and no external network:
//
//   worldsense_sources → worldsense_read → worldsense_snapshot
//   → (the world changes) → worldsense_snapshot → worldsense_history
//   → worldsense_diff
//
// It starts the demo JSON API on an ephemeral loopback port, loads the real
// plugin through apply(), executes the real tools, and tears everything down.
// The snapshot database lives in a throwaway temp directory.
//
// Run:  npm run demo     (or: node examples/worldsense-demo.mjs)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../index.js'
import { startDemoServer } from './demo-server.mjs'

const SECTION = (title) => `\n${'═'.repeat(72)}\n  ${title}\n${'═'.repeat(72)}`

async function main() {
  // ── A throwaway world + a throwaway DSH home ───────────────────────────────
  const home = mkdtempSync(join(tmpdir(), 'worldsense-demo-'))
  const stateFile = join(home, 'demo-state.json')
  writeFileSync(stateFile, JSON.stringify({
    service: 'payment-api',
    version: '1.4.2',
    healthy: true,
    replicas: { desired: 10, ready: 10 },
    queue: { depth: 3 },
    secrets: { password: 'not-a-real-secret', token: 'neither-is-this' },
  }, null, 2))
  process.env.DSH_HOME = home

  const demo = await startDemoServer({ stateFile })

  // ── Administrator-defined source config (the only place URLs exist) ───────
  const config = {
    sources: [
      {
        id: 'payment-demo',
        name: 'Payment Demo Platform',
        description: 'Local demo API (examples/demo-server.mjs)',
        type: 'http-json',
        baseUrl: demo.url,
        auth: { type: 'bearer', credential: 'PAYMENT_TOKEN' },
        timeoutMs: 2000,
        maxResponseBytes: 65536,
        endpoints: {
          'deployment-status': {
            description: 'Current deployment state of payment-api',
            path: '/api/status',
            fields: {
              service: '/service',
              version: '/version',
              healthy: '/healthy',
              desiredReplicas: '/replicas/desired',
              readyReplicas: '/replicas/ready',
            },
          },
          release: {
            path: '/api/release',
            fields: { releaseVersion: '/version', channel: '/channel' },
          },
        },
      },
    ],
  }

  // ── A minimal host: credential store + tool registry ──────────────────────
  const credentials = { PAYMENT_TOKEN: 'demo-token' }
  const registered = []
  const ctx = {
    credentials: { async resolve(ref) { return { value: credentials[ref] ?? '' } } },
    inject() {},
    effect() {},
    systemPrompt: { section() {} },
    tools: { register(tool) { registered.push(tool) } },
  }
  plugin.apply(ctx, config)
  const tool = (name) => {
    const found = registered.find((t) => t.name === name)
    if (!found) throw new Error(`tool ${name} not registered`)
    return found
  }
  const exec = { signal: new AbortController().signal }

  try {
    console.log(SECTION('1. worldsense_sources — which windows exist?'))
    console.log(await tool('worldsense_sources').execute({}, exec))

    console.log(SECTION('2. worldsense_read — observe now (nothing persisted)'))
    console.log(await tool('worldsense_read').execute({
      source: 'payment-demo',
      endpoint: 'deployment-status',
      params: {},
    }, exec))

    console.log(SECTION('3. worldsense_snapshot — capture evidence (v1)'))
    const first = await tool('worldsense_snapshot').execute({
      source: 'payment-demo',
      endpoint: 'deployment-status',
      params: {},
    }, exec)
    console.log(first)
    const firstId = /snapshotId="([^"]+)"/.exec(first)[1]

    console.log(SECTION('… the world changes: version 1.4.2 → 1.5.0, ready 10 → 8 …'))
    writeFileSync(stateFile, JSON.stringify({
      service: 'payment-api',
      version: '1.5.0',
      healthy: true,
      replicas: { desired: 10, ready: 8 },
      queue: { depth: 57 },
      secrets: { password: 'not-a-real-secret', token: 'neither-is-this' },
    }, null, 2))

    console.log(SECTION('4. worldsense_snapshot — capture evidence (v2)'))
    const second = await tool('worldsense_snapshot').execute({
      source: 'payment-demo',
      endpoint: 'deployment-status',
      params: {},
    }, exec)
    console.log(second)
    const secondId = /snapshotId="([^"]+)"/.exec(second)[1]

    console.log(SECTION('5. worldsense_history — what evidence do we hold?'))
    console.log(await tool('worldsense_history').execute({ source: 'payment-demo' }, exec))

    console.log(SECTION(`6. worldsense_diff — ${firstId} → ${secondId}`))
    console.log(await tool('worldsense_diff').execute({ before: firstId, after: secondId }, exec))

    console.log(SECTION('done'))
    console.log(`snapshots stored in: ${join(home, '.dsh', 'worldsense', 'worldsense.db')} (temp, deleted on exit)`)
  } finally {
    await demo.close()
    rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('demo failed:', error)
  process.exitCode = 1
})
