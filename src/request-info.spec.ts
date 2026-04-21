import type { Request } from 'express'
import type { IncomingMessage } from 'http'
import { describe, expect, it } from 'vitest'
import { buildBaseRequestInfo, buildConnectRequestInfo, connectRequestBaseUrl, requestBaseUrl } from './request-info'

type Headers = Record<string, string | string[] | undefined>

const makeExpressRequest = (
  options: {
    headers?: Headers
    protocol?: 'http' | 'https'
    hostname?: string
    method?: string
    originalUrl?: string
    remoteAddress?: string
  } = {},
): Request => {
  const { headers = {}, protocol = 'http', hostname = 'example.com', method = 'GET', originalUrl = '/', remoteAddress } = options
  return {
    headers,
    protocol,
    hostname,
    method,
    originalUrl,
    socket: { remoteAddress },
  } as unknown as Request
}

const makeIncomingMessage = (
  options: {
    headers?: Headers
    method?: string
    url?: string
    remoteAddress?: string
    encrypted?: boolean
  } = {},
): IncomingMessage => {
  const { headers = {}, method = 'GET', url = '/', remoteAddress, encrypted } = options
  const socket: Record<string, unknown> = { remoteAddress }
  if (encrypted !== undefined) socket.encrypted = encrypted
  return {
    headers,
    method,
    url,
    socket,
  } as unknown as IncomingMessage
}

describe('requestBaseUrl', () => {
  it('prefers x-forwarded-host over host header', () => {
    const req = makeExpressRequest({
      protocol: 'https',
      headers: { 'x-forwarded-host': 'public.example.com', host: 'internal:8080' },
    })
    expect(requestBaseUrl(req)).toBe('https://public.example.com')
  })

  it('uses first value when x-forwarded-host is comma-separated', () => {
    const req = makeExpressRequest({
      protocol: 'https',
      headers: { 'x-forwarded-host': 'first.example.com, second.example.com' },
    })
    expect(requestBaseUrl(req)).toBe('https://first.example.com')
  })

  it('uses first value when x-forwarded-host is an array', () => {
    const req = makeExpressRequest({
      protocol: 'http',
      headers: { 'x-forwarded-host': ['one.example.com', 'two.example.com'] },
    })
    expect(requestBaseUrl(req)).toBe('http://one.example.com')
  })

  it('falls back to host header when x-forwarded-host absent', () => {
    const req = makeExpressRequest({
      protocol: 'http',
      headers: { host: 'example.com:3000' },
    })
    expect(requestBaseUrl(req)).toBe('http://example.com:3000')
  })

  it('falls back to req.hostname when no host header available', () => {
    const req = makeExpressRequest({ protocol: 'https', hostname: 'fallback.example.com' })
    expect(requestBaseUrl(req)).toBe('https://fallback.example.com')
  })

  it('strips default http port 80', () => {
    const req = makeExpressRequest({ protocol: 'http', headers: { host: 'example.com:80' } })
    expect(requestBaseUrl(req)).toBe('http://example.com')
  })

  it('strips default https port 443', () => {
    const req = makeExpressRequest({ protocol: 'https', headers: { host: 'example.com:443' } })
    expect(requestBaseUrl(req)).toBe('https://example.com')
  })

  it('keeps non-default port', () => {
    const req = makeExpressRequest({ protocol: 'https', headers: { host: 'example.com:8443' } })
    expect(requestBaseUrl(req)).toBe('https://example.com:8443')
  })

  it('handles bracketed IPv6 host with port', () => {
    const req = makeExpressRequest({ protocol: 'http', headers: { host: '[::1]:8080' } })
    expect(requestBaseUrl(req)).toBe('http://[::1]:8080')
  })

  it('builds localhost URL for typical local dev (http, port 4000, no proxy)', () => {
    const req = makeExpressRequest({ protocol: 'http', hostname: 'localhost', headers: { host: 'localhost:4000' } })
    expect(requestBaseUrl(req)).toBe('http://localhost:4000')
  })
})

describe('connectRequestBaseUrl', () => {
  it('prefers x-forwarded-proto over socket encryption', () => {
    const req = makeIncomingMessage({
      encrypted: true,
      headers: { 'x-forwarded-proto': 'http', host: 'example.com' },
    })
    expect(connectRequestBaseUrl(req)).toBe('http://example.com')
  })

  it('detects https via TLS socket encrypted flag', () => {
    const req = makeIncomingMessage({
      encrypted: true,
      headers: { host: 'example.com' },
    })
    expect(connectRequestBaseUrl(req)).toBe('https://example.com')
  })

  it('defaults to http when no proto signal', () => {
    const req = makeIncomingMessage({ headers: { host: 'example.com:3000' } })
    expect(connectRequestBaseUrl(req)).toBe('http://example.com:3000')
  })

  it('prefers x-forwarded-host over host header', () => {
    const req = makeIncomingMessage({
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'public.example.com', host: 'internal:8080' },
    })
    expect(connectRequestBaseUrl(req)).toBe('https://public.example.com')
  })

  it('strips default port', () => {
    const req = makeIncomingMessage({
      headers: { 'x-forwarded-proto': 'https', host: 'example.com:443' },
    })
    expect(connectRequestBaseUrl(req)).toBe('https://example.com')
  })

  it('throws when no host header available', () => {
    const req = makeIncomingMessage()
    expect(() => connectRequestBaseUrl(req)).toThrow(/Cannot determine base URL/)
  })

  it('builds localhost URL for typical local dev (ws, port 4000, no proxy, unencrypted socket)', () => {
    const req = makeIncomingMessage({ encrypted: false, headers: { host: 'localhost:4000' } })
    expect(connectRequestBaseUrl(req)).toBe('http://localhost:4000')
  })
})

describe('buildBaseRequestInfo', () => {
  it('builds full request info with all headers populated', () => {
    const req = makeExpressRequest({
      protocol: 'https',
      hostname: 'api.example.com',
      method: 'POST',
      originalUrl: '/graphql?q=1',
      headers: {
        'x-request-id': 'req-abc',
        'x-forwarded-host': 'api.example.com:8443',
        host: 'internal:8080',
        origin: 'https://app.example.com',
        referer: 'https://app.example.com/page',
        'x-arr-log-id': 'arr-123',
        'x-forwarded-for': '203.0.113.5, 10.0.0.1',
        'x-correlation-id': 'corr-xyz',
        'user-agent': 'test-agent/1.0',
      },
    })

    expect(buildBaseRequestInfo(req)).toEqual({
      requestId: 'req-abc',
      source: 'http',
      protocol: 'https',
      host: 'api.example.com:8443',
      method: 'POST',
      baseUrl: 'https://api.example.com:8443',
      url: '/graphql?q=1',
      origin: 'https://app.example.com',
      referer: 'https://app.example.com/page',
      arrLogId: 'arr-123',
      clientIp: '203.0.113.5',
      correlationId: 'corr-xyz',
      userAgent: 'test-agent/1.0',
    })
  })

  it('sets source to "http"', () => {
    expect(buildBaseRequestInfo(makeExpressRequest()).source).toBe('http')
  })

  it('generates a uuid for requestId when x-request-id absent', () => {
    const req = makeExpressRequest()
    const info = buildBaseRequestInfo(req)
    expect(info.requestId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('takes first value from x-forwarded-for chain for clientIp', () => {
    const req = makeExpressRequest({
      headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.2, 10.0.0.1' },
    })
    expect(buildBaseRequestInfo(req).clientIp).toBe('203.0.113.5')
  })

  it('falls back to socket.remoteAddress for clientIp when no x-forwarded-for', () => {
    const req = makeExpressRequest({ remoteAddress: '127.0.0.1' })
    expect(buildBaseRequestInfo(req).clientIp).toBe('127.0.0.1')
  })

  it('returns undefined for absent optional fields', () => {
    const req = makeExpressRequest()
    const info = buildBaseRequestInfo(req)
    expect(info.arrLogId).toBeUndefined()
    expect(info.correlationId).toBeUndefined()
    expect(info.userAgent).toBeUndefined()
  })

  it('falls back to req.hostname for host when x-forwarded-host absent', () => {
    const req = makeExpressRequest({ hostname: 'fallback.example.com' })
    expect(buildBaseRequestInfo(req).host).toBe('fallback.example.com')
  })

  it('builds local dev request info (http, localhost:4000, no proxy headers)', () => {
    const req = makeExpressRequest({
      protocol: 'http',
      hostname: 'localhost',
      method: 'POST',
      originalUrl: '/graphql',
      remoteAddress: '::1',
      headers: {
        host: 'localhost:4000',
        origin: 'http://localhost:4000',
        'user-agent': 'curl/8.0.0',
      },
    })

    const info = buildBaseRequestInfo(req)
    expect(info).toMatchObject({
      source: 'http',
      protocol: 'http',
      host: 'localhost',
      baseUrl: 'http://localhost:4000',
      url: '/graphql',
      method: 'POST',
      origin: 'http://localhost:4000',
      clientIp: '::1',
      userAgent: 'curl/8.0.0',
      arrLogId: undefined,
      correlationId: undefined,
    })
    expect(info.requestId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

describe('buildConnectRequestInfo', () => {
  it('builds full request info with wss protocol when encrypted', () => {
    const req = makeIncomingMessage({
      method: 'GET',
      url: '/graphql',
      encrypted: true,
      headers: {
        'x-request-id': 'req-ws',
        'x-forwarded-host': 'api.example.com',
        host: 'internal:8080',
        origin: 'https://app.example.com',
        referer: 'https://app.example.com/page',
        'x-arr-log-id': 'arr-456',
        'x-forwarded-for': '203.0.113.5',
        'x-correlation-id': 'corr-ws',
        'user-agent': 'ws-client/1.0',
      },
    })

    expect(buildConnectRequestInfo(req)).toEqual({
      requestId: 'req-ws',
      source: 'subscription',
      protocol: 'wss',
      host: 'api.example.com',
      method: 'GET',
      baseUrl: 'https://api.example.com',
      url: '/graphql',
      origin: 'https://app.example.com',
      referer: 'https://app.example.com/page',
      arrLogId: 'arr-456',
      clientIp: '203.0.113.5',
      correlationId: 'corr-ws',
      userAgent: 'ws-client/1.0',
    })
  })

  it('sets source to "subscription"', () => {
    const req = makeIncomingMessage({ headers: { host: 'example.com' } })
    expect(buildConnectRequestInfo(req).source).toBe('subscription')
  })

  it('emits ws protocol when socket is unencrypted and no x-forwarded-proto', () => {
    const req = makeIncomingMessage({ encrypted: false, headers: { host: 'example.com' } })
    expect(buildConnectRequestInfo(req).protocol).toBe('ws')
  })

  it('emits wss protocol when x-forwarded-proto is https (normalizing to wss)', () => {
    const req = makeIncomingMessage({ headers: { 'x-forwarded-proto': 'https', host: 'example.com' } })
    expect(buildConnectRequestInfo(req).protocol).toBe('wss')
  })

  it('emits wss protocol when x-forwarded-proto is wss', () => {
    const req = makeIncomingMessage({ headers: { 'x-forwarded-proto': 'wss', host: 'example.com' } })
    expect(buildConnectRequestInfo(req).protocol).toBe('wss')
  })

  it('baseUrl uses http(s) scheme even when protocol is ws/wss', () => {
    const req = makeIncomingMessage({ encrypted: true, headers: { host: 'example.com' } })
    const info = buildConnectRequestInfo(req)
    expect(info.protocol).toBe('wss')
    expect(info.baseUrl).toBe('https://example.com')
  })

  it('falls back to headers.host for host field when x-forwarded-host absent', () => {
    const req = makeIncomingMessage({ headers: { host: 'direct.example.com:8080' } })
    expect(buildConnectRequestInfo(req).host).toBe('direct.example.com:8080')
  })

  it('throws when no host header available', () => {
    const req = makeIncomingMessage()
    expect(() => buildConnectRequestInfo(req)).toThrow(/Cannot determine base URL/)
  })

  it('builds local dev ws request info (localhost:4000, no proxy headers, unencrypted socket)', () => {
    const req = makeIncomingMessage({
      method: 'GET',
      url: '/graphql',
      encrypted: false,
      remoteAddress: '::1',
      headers: {
        host: 'localhost:4000',
        origin: 'http://localhost:4000',
        'user-agent': 'ws-client/1.0',
      },
    })

    const info = buildConnectRequestInfo(req)
    expect(info).toMatchObject({
      source: 'subscription',
      protocol: 'ws',
      host: 'localhost:4000',
      baseUrl: 'http://localhost:4000',
      url: '/graphql',
      origin: 'http://localhost:4000',
      clientIp: '::1',
      userAgent: 'ws-client/1.0',
      arrLogId: undefined,
      correlationId: undefined,
    })
    expect(info.requestId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})
