// test/unicode.test.js — 中文 / 日本語 / emoji survive the whole pipeline
// without encoding damage (spec §57). Protocol identifiers (source/endpoint
// ids, field aliases) are intentionally ASCII-only; unicode lives where humans
// write free text: source names & descriptions, enum values, param values and
// remote payload values — and it must round-trip everywhere.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as plugin from '../index.js'
import { contentHash, stableStringify } from '../lib/hash.js'
import {
  createPluginContext,
  execution,
  installFetch,
  jsonResponse,
  toolByName,
  withTempDshHome,
} from './support.mjs'

const CJK_CONFIG = {
  sources: [
    {
      id: 'business-platform',
      name: '生产业务平台',
      description: '订单与支付状态（中文描述）',
      baseUrl: 'https://biz.example.com',
      endpoints: {
        'daily-summary': {
          description: '当天业务汇总 日本語テスト',
          path: '/api/daily-summary',
          query: {
            region: { type: 'enum', values: ['华北', '華東', '東北'], required: true },
          },
          fields: {
            orders: '/orders',
            revenue: '/revenue',
            note: '/note',
          },
        },
      },
    },
  ],
}

const UNICODE_BODY = () => jsonResponse({
  orders: 1234,
  revenue: 9876.5,
  note: '中文值 🌍 日本語テスト emoji 🚀 déjà vu',
})

test('CJK names, descriptions and enum values validate and list cleanly', async () => {
  const fetchMock = installFetch(UNICODE_BODY)
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, CJK_CONFIG)
  try {
    const output = await toolByName(tools, 'worldsense_sources').execute({}, execution())
    assert.match(output, /source="business-platform" name="生产业务平台"/)
    assert.match(output, /中文描述/)
    assert.match(output, /endpoint="daily-summary"/)
    assert.match(output, /当天业务汇总 日本語テスト/)
    assert.match(output, /region:enum\*\(华北\|華東\|東北\)/)
  } finally {
    fetchMock.restore()
  }
})

test('unicode enum values and remote values round-trip through read uncorrupted', async () => {
  const fetchMock = installFetch(UNICODE_BODY)
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, CJK_CONFIG)
  try {
    const read = toolByName(tools, 'worldsense_read')
    const output = await read.execute({ source: 'business-platform', endpoint: 'daily-summary', params: { region: '華東' } }, execution())
    assert.match(output, /region=%E8%8F%AF%E6%9D%B1/) // properly URL-encoded query value
    assert.match(output, /"note":"中文值 🌍 日本語テスト emoji 🚀 déjà vu"/)
    assert.match(output, /"orders":1234/)
    assert.match(output, /"revenue":9876\.5/)
    // the encoded destination never changed
    assert.equal(new URL(fetchMock.calls[0].url).host, 'biz.example.com')
  } finally {
    fetchMock.restore()
  }
})

test('an invalid unicode enum value is rejected like any other', async () => {
  const fetchMock = installFetch(UNICODE_BODY)
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, CJK_CONFIG)
  try {
    const read = toolByName(tools, 'worldsense_read')
    await assert.rejects(
      () => read.execute({ source: 'business-platform', endpoint: 'daily-summary', params: { region: ' INVALID ' } }, execution()),
      /"region" must be one of/,
    )
  } finally {
    fetchMock.restore()
  }
})

test('hashes are consistent for unicode data regardless of key order', () => {
  const a = { note: '中文 🌍', items: ['日本語', 'emoji 🚀'] }
  const b = { items: ['日本語', 'emoji 🚀'], note: '中文 🌍' }
  assert.equal(contentHash(a), contentHash(b))
  assert.notEqual(contentHash(a), contentHash({ note: '中文 🌎' }))
})

test('stableStringify emits the original code points, never escaped surrogate pairs', () => {
  assert.equal(stableStringify({ k: '日本語' }), '{"k":"日本語"}')
  assert.equal(stableStringify({ e: '🚀' }), '{"e":"🚀"}')
})

test('long CJK values diff with a bounded, non-corrupting display', async () => {
  const home = withTempDshHome()
  const long1 = '中'.repeat(500)
  const long2 = '文'.repeat(500)
  const fetchMock = installFetch(() => jsonResponse({ note: long1 }))
  const { ctx, tools } = createPluginContext({})
  plugin.apply(ctx, CJK_CONFIG)
  try {
    const snapshot = toolByName(tools, 'worldsense_snapshot')
    const first = /snapshotId="([^"]+)"/.exec(await snapshot.execute({ source: 'business-platform', endpoint: 'daily-summary', params: { region: '華東' }, fields: ['note'] }, execution()))[1]
    fetchMock.restore()
    const secondMock = installFetch(() => jsonResponse({ note: long2 }))
    try {
      const second = /snapshotId="([^"]+)"/.exec(await snapshot.execute({ source: 'business-platform', endpoint: 'daily-summary', params: { region: '華東' }, fields: ['note'] }, execution()))[1]
      const diff = await toolByName(tools, 'worldsense_diff').execute({ before: first, after: second }, execution())
      assert.match(diff, /changed \/note: "中+/)
      assert.match(diff, /-> "文+/)
      assert.match(diff, /\[worldsense: truncated\]/)
    } finally {
      secondMock.restore()
    }
  } finally {
    fetchMock.restore()
    home.restore()
  }
})
