import { randomUUID } from 'crypto'
import type { Request } from 'express'
import type { IncomingMessage } from 'http'
import type { TLSSocket } from 'tls'

export interface BaseRequestInfo extends Record<string, unknown> {
  requestId: string
  source: 'http' | 'subscription'
  protocol: 'http' | 'https' | 'ws' | 'wss'
  host: string
  port?: number
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

const resolveHostAndPort = (req: IncomingMessage, fallbackHostname?: string): { host: string; port: number | undefined } => {
  const headerValue = resolveForwardedHost(req) ?? req.headers.host
  if (headerValue) {
    const { hostname, port } = parseHostHeader(headerValue)
    return { host: hostname, port }
  }
  return { host: fallbackHostname ?? '', port: undefined }
}

/**
 * Builds the base URL (`protocol://host[:port]`) for an Express HTTP request, using the request's
 * protocol and resolving the host/port from forwarding headers with the Express hostname as fallback.
 * The port is omitted when it matches the default for the protocol (80 for http, 443 for https).
 * @param req The Express request.
 * @returns The base URL string.
 */
export const requestBaseUrl = (req: Request): string => {
  const { host, port } = resolveHostAndPort(req, req.hostname)
  return formatBaseUrl(req.protocol, host, port)
}

/**
 * Builds the base URL (`http(s)://host[:port]`) for a raw WebSocket upgrade (connect) request.
 * Returns an `https` URL when the connection is TLS-encrypted or `x-forwarded-proto` indicates a
 * secure scheme, otherwise `http`. Throws if no host can be determined from the request headers,
 * since upgrade requests have no Express `hostname` fallback.
 * @param req The incoming upgrade request.
 * @returns The base URL string.
 * @throws Error when the host cannot be resolved from the request.
 */
export const connectRequestBaseUrl = (req: IncomingMessage): string => {
  const { host, port } = resolveHostAndPort(req)
  if (!host) throw new Error('Cannot determine base URL from websocket connect request')
  return formatBaseUrl(isEncryptedConnect(req) ? 'https' : 'http', host, port)
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

export const buildBaseRequestInfo = (req: Request): BaseRequestInfo => {
  const { host, port } = resolveHostAndPort(req, req.hostname)
  return {
    ...buildSharedRequestInfo(req),
    source: 'http',
    protocol: req.protocol as 'http' | 'https',
    host,
    port,
    baseUrl: formatBaseUrl(req.protocol, host, port),
    url: req.originalUrl,
  }
}

export const buildConnectRequestInfo = (req: IncomingMessage): BaseRequestInfo => {
  const { host, port } = resolveHostAndPort(req)
  const protocol = isEncryptedConnect(req) ? 'wss' : 'ws'
  if (!host) throw new Error('Cannot determine base URL from websocket connect request')
  return {
    ...buildSharedRequestInfo(req),
    source: 'subscription',
    protocol,
    host,
    port,
    baseUrl: formatBaseUrl(protocol === 'wss' ? 'https' : 'http', host, port),
    url: req.url ?? '',
  }
}
