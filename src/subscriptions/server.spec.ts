import type { Logger } from '@makerx/node-common'
import { GraphQLBoolean, GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql'
import { createClient, type Client } from 'graphql-ws'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { setTimeout as delay } from 'timers/promises'
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
      ticks: {
        type: GraphQLInt,
        subscribe: async function* () {
          for (let tick = 0; ; tick++) {
            yield { ticks: tick }
            await delay(20)
          }
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

const closeCodeOf = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined

/** Runs a `ticks` subscription for up to `ms`, and reports how many ticks arrived and the close code that ended it, if any. */
const watchTicks = (client: Client, ms: number) =>
  new Promise<{ ticks: number; closeCode?: number }>((resolve) => {
    let ticks = 0
    const unsubscribe = client.subscribe(
      { query: 'subscription { ticks }' },
      {
        next: () => {
          ticks++
        },
        error: (error) => resolve({ ticks, closeCode: closeCodeOf(error) }),
        complete: () => resolve({ ticks }),
      },
    )
    void delay(ms).then(() => {
      unsubscribe()
      resolve({ ticks })
    })
  })

const epochSeconds = (offsetSeconds: number) => Math.floor(Date.now() / 1000) + offsetSeconds

const pingsWithin = async (url: string, ms: number) => {
  const socket = new WebSocket(url, 'graphql-transport-ws')
  cleanup.push(() => socket.close())
  let pings = 0
  socket.on('ping', () => pings++)
  await new Promise((resolve) => socket.once('open', resolve))
  await delay(ms)
  return pings
}

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

  describe('closeOnTokenExpiry', () => {
    const bearer = { connectionParams: { Authorization: 'Bearer token-params' } }

    it('closes the connection with 4403 when the token expires, ending a running subscription', async () => {
      const verifyToken = vi.fn(async () => ({ ...claims, exp: epochSeconds(1) }))
      const { url, logger } = await startServer({ verifyToken, requireAuth: true, closeOnTokenExpiry: true })

      const result = await watchTicks(connect(url, bearer), 3000)

      expect(result.closeCode).toBe(4403)
      expect(result.ticks).toBeGreaterThan(0)
      expect(logger.info).toHaveBeenCalledWith('Subscription connection auth token expired', {
        claims: { oid: 'oid-1', iss: 'https://issuer.example' },
      })
    })

    it('closes the connection at once when the token has already expired', async () => {
      const verifyToken = vi.fn(async () => ({ ...claims, exp: epochSeconds(-10) }))
      const { url } = await startServer({ verifyToken, requireAuth: true, closeOnTokenExpiry: true })

      const result = await watchTicks(connect(url, bearer), 1000)

      expect(result.closeCode).toBe(4403)
    })

    it('leaves the connection open when the option is not set', async () => {
      const verifyToken = vi.fn(async () => ({ ...claims, exp: epochSeconds(-10) }))
      const { url } = await startServer({ verifyToken, requireAuth: true })

      const result = await watchTicks(connect(url, bearer), 200)

      expect(result.closeCode).toBeUndefined()
      expect(result.ticks).toBeGreaterThan(0)
    })

    it('leaves the connection open when the claims have no exp', async () => {
      const verifyToken = vi.fn(async () => claims)
      const { url } = await startServer({ verifyToken, requireAuth: true, closeOnTokenExpiry: true })

      const result = await watchTicks(connect(url, bearer), 200)

      expect(result.closeCode).toBeUndefined()
      expect(result.ticks).toBeGreaterThan(0)
    })

    it('stops the timer when the client disconnects first', async () => {
      const exp = epochSeconds(1)
      const verifyToken = vi.fn(async () => ({ ...claims, exp }))
      const { url, logger } = await startServer({ verifyToken, requireAuth: true, closeOnTokenExpiry: true })
      const client = connect(url, bearer)

      await watchTicks(client, 50)
      await client.dispose()
      await delay(exp * 1000 - Date.now() + 100)

      expect(logger.info).toHaveBeenCalledWith('Subscription connection disconnected', expect.anything())
      expect(logger.info).not.toHaveBeenCalledWith('Subscription connection auth token expired', expect.anything())
    })
  })

  describe('keepAlive', () => {
    it('pings the client at the given interval', async () => {
      const { url } = await startServer({ keepAlive: 50 })

      expect(await pingsWithin(url, 280)).toBeGreaterThanOrEqual(3)
    })

    it('sends no pings when it is 0', async () => {
      const { url } = await startServer({ keepAlive: 0 })

      expect(await pingsWithin(url, 280)).toBe(0)
    })
  })
})
