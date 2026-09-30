import type { Logger } from '@makerx/node-common'
import { GraphQLBoolean, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql'
import { createClient, type Client } from 'graphql-ws'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { GraphQLContext, JwtPayload } from '../context'
import { createSubscriptionContextFactory, type ExtractSubscriptionToken } from './context'
import { useSubscriptionsServer } from './server'

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: 'Query', fields: { ok: { type: GraphQLBoolean, resolve: () => true } } }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      token: {
        type: GraphQLString,
        subscribe: async function* (_source: unknown, _args: unknown, context: GraphQLContext) {
          yield { token: context.user?.token }
        },
      },
    },
  }),
})

const makeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger

const webSocketWithHeaders = (headers: Record<string, string>) =>
  class extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers })
    }
  }

const extractAssertion: ExtractSubscriptionToken = ({ connectRequest }) => {
  const assertion = connectRequest.headers['x-goog-iap-jwt-assertion']
  return typeof assertion === 'string' ? assertion : undefined
}

const claims: JwtPayload = { oid: 'oid-1', iss: 'https://issuer.example' }

let cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

const startServer = async (options: Partial<Parameters<typeof useSubscriptionsServer>[0]>) => {
  const httpServer: Server = createServer()
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const logger = makeLogger()
  const disposable = useSubscriptionsServer({
    schema,
    httpServer,
    logger,
    createSubscriptionContext: createSubscriptionContextFactory({ requestLogger: logger, extractToken: options.extractToken }),
    ...options,
  })
  cleanup.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())))
  cleanup.push(() => disposable.dispose())
  return { url: `ws://localhost:${(httpServer.address() as AddressInfo).port}/graphql`, logger }
}

const connect = (url: string, options: { headers?: Record<string, string>; connectionParams?: Record<string, unknown> } = {}) => {
  const client: Client = createClient({
    url,
    webSocketImpl: webSocketWithHeaders(options.headers ?? {}),
    connectionParams: options.connectionParams,
    retryAttempts: 0,
  })
  cleanup.push(() => client.dispose())
  return client
}

const subscribeToToken = (client: Client) =>
  new Promise<unknown>((resolve, reject) => {
    client.subscribe({ query: 'subscription { token }' }, { next: ({ data }) => resolve(data?.token), error: reject, complete: () => {} })
  })

describe('useSubscriptionsServer', () => {
  it('verifies the bearer token from the connection params by default', async () => {
    const verifyToken = vi.fn(async () => claims)
    const { url } = await startServer({ verifyToken, requireAuth: true })

    const token = await subscribeToToken(connect(url, { connectionParams: { Authorization: 'Bearer token-params' } }))

    expect(verifyToken).toHaveBeenCalledWith(expect.any(String), 'token-params')
    expect(token).toBe('token-params')
  })

  it('verifies the token returned by extractToken on connect and on subscribe', async () => {
    const verifyToken = vi.fn(async () => claims)
    const { url } = await startServer({ verifyToken, requireAuth: true, extractToken: extractAssertion })

    const token = await subscribeToToken(
      connect(url, {
        headers: { 'x-goog-iap-jwt-assertion': 'assertion-jwt' },
        connectionParams: { Authorization: 'Bearer token-params' },
      }),
    )

    expect(verifyToken).toHaveBeenCalledTimes(2)
    expect(verifyToken).toHaveBeenNthCalledWith(1, expect.any(String), 'assertion-jwt')
    expect(verifyToken).toHaveBeenNthCalledWith(2, expect.any(String), 'assertion-jwt')
    expect(token).toBe('assertion-jwt')
  })

  it('rejects the connection when requireAuth is set and extractToken returns no token', async () => {
    const verifyToken = vi.fn(async () => claims)
    const { url, logger } = await startServer({ verifyToken, requireAuth: true, extractToken: extractAssertion })

    await expect(subscribeToToken(connect(url, { connectionParams: { Authorization: 'Bearer token-params' } }))).rejects.toMatchObject({
      code: 4403,
    })

    expect(verifyToken).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('No auth token was supplied with the websocket connection')
  })
})
