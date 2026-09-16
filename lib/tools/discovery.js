// lib/tools/discovery.js — The look-before-you-leap tools:
//   worldsense_sources — which windows into the world exist (never secrets)
//   worldsense_status  — is one source/endpoint readable right now
// Neither returns remote content. Every listing is bounded.
import { defineTool } from '@deepseek-ai/dsh-tools'

import { MAX_SOURCE_LIST_LINES, STATUS_TOOL_TIMEOUT_MS, TOOL_TIMEOUT_MS } from '../constants.js'
import { resolveEndpoint, resolveSource } from '../config.js'
import { buildRequestUrl, probeJson } from '../http.js'
import { CODES } from '../failures.js'
import { validateParams } from '../observation.js'
import { oneLine, textOut } from '../util.js'

const SOURCE_PARAM = {
  type: 'string',
  required: true,
  description: 'Source id exactly as listed by worldsense_sources (e.g. "prod-platform"). This selects an administrator-configured window; arbitrary URLs are never accepted.',
}

export function defineWorldsenseSourcesTool(rt) {
  return defineTool({
    name: 'worldsense_sources',
    description: 'List the administrator-configured WorldSense sources: each source id, name, description, base URL, auth mode (never credential values, only whether they are set) and every endpoint with its fixed path, its whitelisted query parameters (name, type, required, enum values, min/max, default) and its field aliases (the only field names other tools accept). Call this first to discover valid source/endpoint/field/param names. Read-only and fully local.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', title: 'List configured WorldSense sources', kind: 'read' }),
    async execute() {
      const sources = await rt.listSources()
      if (sources.length === 0) {
        return '(no WorldSense sources are configured — the administrator defines sources and endpoints in Settings → Plugins)'
      }
      const lines = []
      let truncated = false
      for (const source of sources) {
        if (lines.length >= MAX_SOURCE_LIST_LINES) {
          truncated = true
          break
        }
        lines.push(
          [
            `source=${JSON.stringify(source.id)}`,
            source.name !== source.id ? `name=${JSON.stringify(source.name)}` : '',
            source.description ? `description=${JSON.stringify(oneLine(source.description, 200))}` : '',
            `type=${source.type}`,
            `baseUrl=${JSON.stringify(source.baseUrl)}`,
            `auth=${source.auth}`,
            `credentials=${source.credentialsConfigured ? 'configured' : 'missing'}`,
          ].filter(Boolean).join(' '),
        )
        for (const endpoint of source.endpoints) {
          if (lines.length >= MAX_SOURCE_LIST_LINES) {
            truncated = true
            break
          }
          const params = endpoint.params.length
            ? endpoint.params
                .map((p) => `${p.name}:${p.type}${p.required ? '*' : ''}${p.values ? `(${p.values.join('|')})` : ''}${p.default !== undefined ? `=${JSON.stringify(p.default)}` : ''}`)
                .join(' ')
            : '(none)'
          lines.push(
            [
              `  endpoint=${JSON.stringify(endpoint.id)}`,
              `path=${JSON.stringify(endpoint.path)}`,
              `params=${params}`,
              `fields=${endpoint.fields.map((f) => JSON.stringify(f)).join(', ')}`,
              endpoint.description ? `# ${oneLine(endpoint.description, 160)}` : '',
            ].filter(Boolean).join(' '),
          )
        }
      }
      if (truncated) lines.push(`budget: listing truncated at ${MAX_SOURCE_LIST_LINES} lines (too many sources/endpoints configured).`)
      return lines.join('\n')
    },
  })
}

export function defineWorldsenseStatusTool(rt) {
  return defineTool({
    name: 'worldsense_status',
    description: 'Check whether one source endpoint is readable right now: reachable (yes/no), latency in ms, HTTP status, whether the body is valid JSON, and observedAt. Never returns the response body. When endpoint is omitted the source\'s first configured endpoint is probed. Read-only.',
    parameters: {
      source: SOURCE_PARAM,
      endpoint: { type: 'string', description: 'Optional endpoint id of this source (defaults to the first configured endpoint). See worldsense_sources.' },
      params: { type: 'object', additionalProperties: true, description: 'Optional whitelisted query parameters for the probed endpoint (same validation as worldsense_read); defaults are applied automatically.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textOut(value) },
    timeoutMs: STATUS_TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: `Check world source ${oneLine(String(args?.source ?? ''), 40)}${args?.endpoint ? ` endpoint ${oneLine(String(args.endpoint), 40)}` : ''}`, kind: 'read' }),
    async execute(args, exec) {
      const cfg = rt.config()
      const source = resolveSource(cfg, args.source)
      const endpoint = resolveEndpoint(source, args.endpoint)
      const { search } = validateParams(endpoint, args.params)
      const url = buildRequestUrl(source.baseUrl, endpoint.path, search)
      const headers = await rt.buildHeaders(source)
      const probed = await probeJson({
        url,
        headers,
        timeoutMs: source.timeoutMs,
        maxResponseBytes: source.maxResponseBytes,
        signal: exec.signal,
        sourceId: source.id,
        endpointId: endpoint.id,
      })
      const lines = [
        `source=${JSON.stringify(source.id)} endpoint=${JSON.stringify(endpoint.id)} url=${JSON.stringify(url)}`,
        `reachable=${probed.reachable ? 'yes' : 'no'} latencyMs=${probed.latencyMs ?? '-'} httpStatus=${probed.httpStatus ?? '-'} json=${probed.healthy ? 'yes' : 'no'} observedAt=${new Date().toISOString()}`,
        `credentials=${source.auth.type === 'none' ? 'not-required' : 'applied'}`,
      ]
      if (probed.error) {
        const code = probed.error.code ?? CODES.CONNECTION_FAILED
        lines.push(`error=${code}: ${oneLine(probed.error.message, 280)}`)
      }
      return lines.join('\n')
    },
  })
}
