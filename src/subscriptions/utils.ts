import type { IncomingMessage } from 'http'

/**
 * Extracts a token from a connection parameter named `authorization` or `Authorization`.
 * The expected format of the parameter value is: Bearer <token>, consistent with an HTTP Authorization header.
 * Apollo Sandbox sets an `Authorization` connection parameter when you specify an HTTP Authorization header via the UI.
 * @param connectionParams
 * @returns
 */
export function extractTokenFromConnectionParams(connectionParams?: Readonly<Record<string, unknown>>) {
  const bearerTokenValue = (connectionParams?.authorization ?? connectionParams?.Authorization) as string | undefined
  if (!bearerTokenValue?.startsWith('Bearer ')) return undefined
  return bearerTokenValue.substring(7)
}

export function getHost(request: IncomingMessage) {
  const proxyHostHeader = request.headers['x-forwarded-host']
  return proxyHostHeader?.[0] ?? proxyHostHeader ?? request.headers.host ?? 'subscriptions'
}
