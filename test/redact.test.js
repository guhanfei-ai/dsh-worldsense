// test/redact.test.js — Best-effort secret redaction (spec §52): password,
// token, authorization, api_key, nested secrets, array secrets, Bearer tokens
// inside strings — and the guarantee that neither tool output nor snapshots
// contain the secret.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { isSensitiveKey, pointerTouchesSensitiveKey, redactString, redactValue } from '../lib/redact.js'
import {
  createPluginContext,
  demoCredentials,
  demoSourceConfig,
  execution,
  installFetch,
  jsonResponse,
  paymentApiBody,
  toolByName,
  withTempDshHome,
} from './support.mjs'

const { REDACTED } = { REDACTED: '[REDACTED]' }

// ── Key-based redaction ──────────────────────────────────────────────────────
test('sensitive keys are recognized case- and separator-insensitively', () => {
  for (const key of ['password', 'PASSWORD', 'Pass_Word', 'passwd', 'apiKey', 'api_key', 'API-KEY', 'authorization', 'Authorization', 'accessToken', 'access_token', 'clientSecret', 'set-cookie', 'credential', 'privateKey']) {
    assert.equal(isSensitiveKey(key), true, `${key} must be sensitive`)
  }
  // Deliberately NOT sensitive: words that describe auth without carrying it.
  for (const key of ['version', 'status', 'queueDepth', 'count', 'region', 'descriptions', 'auth', 'authMode', 'credentials']) {
    assert.equal(isSensitiveKey(key), false, `${key} must stay readable`)
  }
})

test('redactValue replaces sensitive-keyed values at every level and inside arrays', () => {
  const input = {
    status: 'healthy',
    auth: { token: 'abc', mode: 'bearer' },
    db: { password: 'hunter2', host: 'db1' },
    owners: [{ name: 'a', apiKey: 'k1' }, { name: 'b', apiKey: 'k2' }],
    nested: { deep: { client_secret: 's3' } },
  }
  const out = redactValue(input)
  assert.equal(out.status, 'healthy')
  assert.equal(out.auth.token, REDACTED)
  assert.equal(out.auth.mode, 'bearer')
  assert.equal(out.db.password, REDACTED)
  assert.equal(out.db.host, 'db1')
  assert.equal(out.owners[0].apiKey, REDACTED)
  assert.equal(out.owners[1].apiKey, REDACTED)
  assert.equal(out.nested.deep.client_secret, REDACTED)
  assert.equal(JSON.stringify(out).includes('hunter2'), false)
})

test('redactString scrubs credential-looking fragments inside ordinary strings', () => {
  // The whole credential shape (keyword and value) is replaced.
  assert.equal(redactString('authorized via Authorization: Bearer eyJhbGciOi.very.long.token.value123'), 'authorized via Authorization: [REDACTED]')
  assert.equal(redactString('error: password=hunter2 rejected'), 'error: [REDACTED] rejected')
  assert.equal(redactString('api_key=sk-abcdefghijklmnop1234'), '[REDACTED]')
  assert.equal(redactString('payment-api version 1.4.2 healthy'), 'payment-api version 1.4.2 healthy')
  assert.equal(redactString('nothing to see here'), 'nothing to see here')
})

test('a pointer selecting through a sensitive key is detected', () => {
  assert.equal(pointerTouchesSensitiveKey('/db/password'), true)
  assert.equal(pointerTouchesSensitiveKey('/secrets/0/token'), true)
  assert.equal(pointerTouchesSensitiveKey('/replicas/desired'), false)
  assert.equal(pointerTouchesSensitiveKey('/status'), false)
})

// ── End-to-end: neither tool output nor snapshots contain secrets ────────────
test('a malicious payload echoing credentials is redacted in read output', async () => {
  const secret = 'payment-secret-token-abc123'
  const fetchMock = installFetch(() => jsonResponse({
    ...paymentApiBody(),
    echo: { authorization: `Bearer ${secret}`, password: 'leaked-password', note: `auth via Bearer ${secret} ok` },
  }))
  const { ctx, tools } = createPluginContext({ credentials: demoCredentials() })
  plugin.apply(ctx, demoSourceConfig())
  try {
    const read = toolByName(tools, 'worldsense_read')
    // The config only aliases safe fields, but include the echo keys via
    // a config that aliases them — redaction must hold even for a bad config.
    const cfg = demoSourceConfig()
    cfg.sources[0].endpoints['deployment-status'].fields.echo = '/echo'
    const { ctx: ctx2, tools: tools2 } = createPluginContext({ credentials: demoCredentials() })
    plugin.apply(ctx2, cfg)
    const read2 = toolByName(tools2, 'worldsense_read')
    const output = await read2.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: 'prod' } }, execution())
    assert.ok(!output.includes(secret), 'the credential value must never appear')
    assert.ok(!output.includes('leaked-password'), 'sensitive keys must be redacted')
    assert.match(output, /"echo":\{"authorization":"\[REDACTED\]","note":"auth via \[REDACTED\] ok","password":"\[REDACTED\]"\}/)
    read // keep reference
  } finally {
    fetchMock.restore()
  }
})

test('snapshots persist only redacted data', async () => {
  const secret = 'payment-secret-token-abc123'
  const home = withTempDshHome()
  const fetchMock = installFetch(() => jsonResponse({
    ...paymentApiBody(),
    conn: { password: 'db-password-9', token: secret },
  }))
  try {
    const cfg = demoSourceConfig()
    cfg.sources[0].endpoints['deployment-status'].fields.conn = '/conn'
    const { ctx, tools } = createPluginContext({ credentials: demoCredentials() })
    plugin.apply(ctx, cfg)
    const snapshot = toolByName(tools, 'worldsense_snapshot')
    const output = await snapshot.execute({ source: 'prod-platform', endpoint: 'deployment-status', params: { environment: 'prod' } }, execution())
    assert.ok(!output.includes(secret))
    assert.ok(!output.includes('db-password-9'))

    const dbFile = `${home.dir}/worldsense/worldsense.db`
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const rows = db.prepare('SELECT data_json, metadata_json FROM snapshots').all()
      assert.ok(rows.length >= 1)
      for (const row of rows) {
        assert.ok(!`${row.data_json}${row.metadata_json}`.includes(secret), 'snapshot rows must not contain the credential')
        assert.ok(!`${row.data_json}`.includes('db-password-9'), 'snapshot data must be redacted')
      }
    } finally {
      db.close()
    }
  } finally {
    fetchMock.restore()
    home.restore()
  }
})
