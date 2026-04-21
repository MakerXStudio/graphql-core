import type { Logger } from '@makerx/node-common'
import type { IncomingMessage } from 'http'
import { describe, expect, it, vi } from 'vitest'
import type { JwtPayload } from '../context'
import { User } from '../User'
import { createSubscriptionContextFactory } from './context'

type Headers = Record<string, string | string[] | undefined>

const makeConnectRequest = (
  options: {
    headers?: Headers
    method?: string
    url?: string
    remoteAddress?: string
    encrypted?: boolean
  } = {},
): IncomingMessage => {
  const { headers = { host: 'example.com' }, method = 'GET', url = '/graphql', remoteAddress, encrypted } = options
  const socket: Record<string, unknown> = { remoteAddress }
  if (encrypted !== undefined) socket.encrypted = encrypted
  return { headers, method, url, socket } as unknown as IncomingMessage
}

const makeLogger = (): Logger => {
  const fn = vi.fn()
  return { info: fn, warn: fn, error: fn, debug: fn } as unknown as Logger
}

const sampleClaims: JwtPayload = {
  oid: 'oid-1',
  iss: 'https://issuer.example',
  sub: 'sub-1',
  scp: 'read',
}

describe('createSubscriptionContextFactory', () => {
  it('builds a default User from claims and the bearer token in connectionParams', async () => {
    const createContext = createSubscriptionContextFactory({ requestLogger: makeLogger() })

    const context = await createContext({
      connectRequest: makeConnectRequest(),
      claims: sampleClaims,
      connectionParams: { authorization: 'Bearer token-ws' },
    })

    expect(context.user).toBeInstanceOf(User)
    expect(context.user?.token).toBe('token-ws')
    expect(context.user?.id).toBe('oid-1')
  })

  it('leaves user undefined when no claims are provided', async () => {
    const createContext = createSubscriptionContextFactory({ requestLogger: makeLogger() })
    const context = await createContext({ connectRequest: makeConnectRequest() })
    expect(context.user).toBeUndefined()
  })

  it('uses a supplied createUser and passes its result to requestLogger', async () => {
    type AppUser = { id: string; instance: string }
    const requestLogger = vi.fn((_metadata: Record<string, unknown>, _user: AppUser) => makeLogger())

    const createContext = createSubscriptionContextFactory({
      requestLogger,
      createUser: async (): Promise<AppUser> => ({ id: 'u-1', instance: 'tenant-a' }),
    })

    const context = await createContext({ connectRequest: makeConnectRequest(), claims: sampleClaims })

    expect(context.user).toEqual({ id: 'u-1', instance: 'tenant-a' })
    expect(requestLogger.mock.calls[0][1]).toEqual({ id: 'u-1', instance: 'tenant-a' })
  })

  it('includes filtered request info and claims in the requestLogger metadata', async () => {
    const requestLogger = vi.fn((_metadata: Record<string, unknown>, _user: User | undefined) => makeLogger())

    const createContext = createSubscriptionContextFactory({
      requestLogger,
      claimsToLog: ['oid', 'iss'],
      requestInfoToLog: ['requestId', 'protocol'],
    })

    await createContext({
      connectRequest: makeConnectRequest({ headers: { host: 'example.com', 'x-request-id': 'req-ws' } }),
      claims: sampleClaims,
    })

    const metadata = requestLogger.mock.calls[0][0] as {
      request: Record<string, unknown>
      user: Record<string, unknown>
    }
    expect(metadata.request).toEqual({ requestId: 'req-ws', protocol: 'ws' })
    expect(metadata.user).toEqual({ oid: 'oid-1', iss: 'https://issuer.example' })
  })

  it('uses a Logger instance directly without invoking it as a factory', async () => {
    const logger = makeLogger()
    const createContext = createSubscriptionContextFactory({ requestLogger: logger })
    const context = await createContext({ connectRequest: makeConnectRequest() })
    expect(context.logger).toBe(logger)
  })

  it('merges augmentContext output onto the context', async () => {
    const createContext = createSubscriptionContextFactory({
      requestLogger: makeLogger(),
      augmentContext: () => ({ channel: 'subs' }),
    })

    const context = await createContext({ connectRequest: makeConnectRequest() })
    expect(context.channel).toBe('subs')
  })

  it('merges augmentRequestInfo output onto requestInfo', async () => {
    const createContext = createSubscriptionContextFactory({
      requestLogger: makeLogger(),
      augmentRequestInfo: () => ({ tenant: 'acme' }),
    })

    const context = await createContext({ connectRequest: makeConnectRequest() })
    expect((context.requestInfo as Record<string, unknown>).tenant).toBe('acme')
  })

  it('marks requestInfo.source as "subscription"', async () => {
    const createContext = createSubscriptionContextFactory({ requestLogger: makeLogger() })
    const context = await createContext({ connectRequest: makeConnectRequest() })
    expect(context.requestInfo.source).toBe('subscription')
  })
})
