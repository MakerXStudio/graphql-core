import { randomUUID } from 'crypto'
import type { Request } from 'express'
import type { IncomingMessage } from 'http'
import type { TLSSocket } from 'tls'

export interface BaseRequestInfo extends Record<string, unknown> {
  requestId: string
  source: 'http' | 'subscription'
  protocol: 'http' | 'https' | 'ws' | 'wss'
  host: string
  method: string
  baseUrl: string
  url: string
  origin: string
  referer?: string
  correlationId?: string
  arrLogId?: string
  clientIp?: string
  userAgent?: string
}

const isDefaultPort = (protocol: string, port: number | undefined): boolean =>
  port == null || (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443)

const formatBaseUrl = (protocol: string, hostname: string, port: number | undefined): string =>
  isDefaultPort(protocol, port) ? `${protocol}://${hostname}` : `${protocol}://${hostname}:${port}`

const firstHeaderValue = (value: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(value) ? value[0] : value
  return raw?.split(',')[0]?.trim() || undefined
}

const parseHostHeader = (hostHeader: string): { hostname: string; port: number | undefined } => {
  const url = new URL(`http://${hostHeader}`)
  return { hostname: url.hostname, port: url.port ? Number(url.port) : undefined }
}

const isEncryptedSocket = (req: IncomingMessage): boolean => 'encrypted' in req.socket && (req.socket as TLSSocket).encrypted === true

const isEncryptedConnect = (req: IncomingMessage): boolean => {
  const forwarded = firstHeaderValue(req.headers['x-forwarded-proto'])?.toLowerCase()
  if (forwarded === 'https' || forwarded === 'wss') return true
  if (forwarded === 'http' || forwarded === 'ws') return false
  return isEncryptedSocket(req)
}

const resolveForwardedHost = (req: IncomingMessage): string | undefined => firstHeaderValue(req.headers['x-forwarded-host'])

export const requestBaseUrl = (req: Request): string => {
  const hostHeader = resolveForwardedHost(req) ?? req.headers.host
  const { hostname, port } = hostHeader ? parseHostHeader(hostHeader) : { hostname: req.hostname, port: undefined }
  return formatBaseUrl(req.protocol, hostname, port)
}

export const connectRequestBaseUrl = (req: IncomingMessage): string => {
  const hostHeader = resolveForwardedHost(req) ?? req.headers.host
  if (!hostHeader) throw new Error('Cannot determine base URL from websocket connect request')
  const { hostname, port } = parseHostHeader(hostHeader)
  return formatBaseUrl(isEncryptedConnect(req) ? 'https' : 'http', hostname, port)
}

const buildSharedRequestInfo = (req: IncomingMessage) => ({
  requestId: req.headers['x-request-id']?.toString() ?? randomUUID(),
  method: req.method ?? '',
  origin: req.headers.origin ?? '',
  referer: req.headers.referer?.toString() ?? '',
  arrLogId: req.headers['x-arr-log-id']?.toString() ?? undefined,
  clientIp: firstHeaderValue(req.headers['x-forwarded-for']) ?? req.socket.remoteAddress,
  correlationId: req.headers['x-correlation-id']?.toString() ?? undefined,
  userAgent: req.headers['user-agent']?.toString() ?? undefined,
})

export const buildBaseRequestInfo = (req: Request): BaseRequestInfo => ({
  ...buildSharedRequestInfo(req),
  source: 'http',
  protocol: req.protocol as 'http' | 'https',
  host: resolveForwardedHost(req) ?? req.hostname ?? '',
  baseUrl: requestBaseUrl(req),
  url: req.originalUrl,
})

export const buildConnectRequestInfo = (req: IncomingMessage): BaseRequestInfo => ({
  ...buildSharedRequestInfo(req),
  source: 'subscription',
  protocol: isEncryptedConnect(req) ? 'wss' : 'ws',
  host: resolveForwardedHost(req) ?? req.headers.host ?? '',
  baseUrl: connectRequestBaseUrl(req),
  url: req.url ?? '',
})
