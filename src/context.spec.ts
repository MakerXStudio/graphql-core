import type { Logger } from '@makerx/node-common'
import type { Request } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { createContextFactory, type JwtPayload, type LambdaContext } from './context'
import { User } from './User'

type Headers = Record<string, string | string[] | undefined>

const makeRequest = (
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

const makeLogger = (): Logger => {
  const fn = vi.fn()
  return { info: fn, warn: fn, error: fn, debug: fn } as unknown as Logger
}

const sampleClaims: JwtPayload = {
  oid: 'oid-1',
  iss: 'https://issuer.example',
  sub: 'sub-1',
  aud: 'api://app',
  scp: 'read write',
  roles: ['admin'],
  email: 'jane@example.com',
}

describe('createContextFactory', () => {
  it('builds a default User when claims are provided and createUser is omitted', async () => {
    const logger = makeLogger()
    const createContext = createContextFactory({ requestLogger: logger })

    const context = await createContext({
      req: makeRequest({ headers: { authorization: 'Bearer token-abc' } }),
      claims: sampleClaims,
    })

    expect(context.user).toBeInstanceOf(User)
    expect(context.user?.token).toBe('token-abc')
    expect(context.user?.id).toBe('oid-1')
  })

  it('leaves user undefined when no claims and createUser is omitted', async () => {
    const createContext = createContextFactory({ requestLogger: makeLogger() })
    const context = await createContext({ req: makeRequest() })
    expect(context.user).toBeUndefined()
  })

  it('uses a supplied createUser and passes its result to requestLogger', async () => {
    type AppUser = { id: string; instance: string }
    const requestLogger = vi.fn((_metadata: Record<string, unknown>, _user: AppUser) => makeLogger())

    const createContext = createContextFactory({
      requestLogger,
      createUser: async (): Promise<AppUser> => ({ id: 'u-1', instance: 'tenant-a' }),
    })

    const context = await createContext({ req: makeRequest(), claims: sampleClaims })

    expect(context.user).toEqual({ id: 'u-1', instance: 'tenant-a' })
    expect(requestLogger).toHaveBeenCalledTimes(1)
    expect(requestLogger.mock.calls[0][1]).toEqual({ id: 'u-1', instance: 'tenant-a' })
  })

  it('includes filtered request info and claims in the requestLogger metadata', async () => {
    const requestLogger = vi.fn((_metadata: Record<string, unknown>, _user: User | undefined) => makeLogger())

    const createContext = createContextFactory({
      requestLogger,
      claimsToLog: ['oid', 'iss'],
      requestInfoToLog: ['requestId', 'origin'],
    })

    await createContext({
      req: makeRequest({ headers: { origin: 'https://app.example.com', 'x-request-id': 'req-1' } }),
      claims: sampleClaims,
    })

    const metadata = requestLogger.mock.calls[0][0] as {
      request: Record<string, unknown>
      user: Record<string, unknown>
    }
    expect(metadata.request).toEqual({ requestId: 'req-1', origin: 'https://app.example.com' })
    expect(metadata.user).toEqual({ oid: 'oid-1', iss: 'https://issuer.example' })
  })

  it('uses a Logger instance directly without invoking it as a factory', async () => {
    const logger = makeLogger()
    const createContext = createContextFactory({ requestLogger: logger })
    const context = await createContext({ req: makeRequest() })
    expect(context.logger).toBe(logger)
  })

  it('merges augmentContext output onto the context', async () => {
    const logger = makeLogger()
    const createContext = createContextFactory({
      requestLogger: logger,
      augmentContext: (context) => ({ tag: 'augmented', startedMirror: context.started }),
    })

    const context = await createContext({ req: makeRequest() })
    expect(context.tag).toBe('augmented')
    expect(context.startedMirror).toBe(context.started)
  })

  it('merges augmentRequestInfo output onto requestInfo', async () => {
    const createContext = createContextFactory({
      requestLogger: makeLogger(),
      augmentRequestInfo: () => ({ tenant: 'acme' }),
    })

    const context = await createContext({ req: makeRequest() })
    expect((context.requestInfo as Record<string, unknown>).tenant).toBe('acme')
  })

  it('adds lambda fields to requestInfo when a LambdaContext is supplied', async () => {
    const lambdaContext: LambdaContext = { awsRequestId: 'aws-1', functionName: 'my-fn' }
    const createContext = createContextFactory({ requestLogger: makeLogger() })

    const context = await createContext({ req: makeRequest(), context: lambdaContext })
    expect(context.requestInfo).toMatchObject({ awsRequestId: 'aws-1', functionName: 'my-fn' })
  })
})
