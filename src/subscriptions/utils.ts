import type { IncomingMessage } from 'http'

export function extractTokenFromConnectionParams(connectionParams?: Readonly<Record<string, unknown>>) {
  const bearerTokenValue = (connectionParams?.authorization ?? connectionParams?.Authorization) as string | undefined
  if (!bearerTokenValue || !bearerTokenValue.startsWith('Bearer ')) return undefined
  return bearerTokenValue.substring(7)
}

export function getHost(request: IncomingMessage) {
  const proxyHostHeader = request.headers['x-forwarded-host']
  const host = Array.isArray(proxyHostHeader) ? proxyHostHeader[0] ?? undefined : proxyHostHeader ?? request.headers.host ?? undefined
  return host ?? 'subscriptions'
}
