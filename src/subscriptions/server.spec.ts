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

// How many times a bump operation has run, so a test can tell that a refused operation did not run.
let bumps = 0

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({ name: 'Query', fields: { ok: { type: GraphQLBoolean, resolve: () => true } } }),
  mutation: new GraphQLObjectType({ name: 'Mutation', fields: { bump: { type: GraphQLInt, resolve: () => ++bumps } } }),
  subscription: new GraphQLObjectType({
    name: 'Subscription',
    fields: {
      bump: {
        type: GraphQLInt,
        subscribe: async function* () {
          yield { bump: ++bumps }
        },
      },
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
      // Yields once, then waits for an event that never comes, as a subscription does between events. graphql-ws's
      // onClose waits for every subscription on the connection to return, which this one cannot do while it waits.
      stalls: {
        type: GraphQLInt,
        subscribe: async function* () {
          yield { stalls: 1 }
          await new Promise(() => {})
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
  bumps = 0
  vi.restoreAllMocks()
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

const bump = (client: Client, operationType: 'query' | 'mutation' | 'subscription' = 'subscription') =>
  new Promise<unknown>((resolve, reject) => {
    const query = operationType === 'query' ? '{ ok }' : `${operationType} { bump }`
    client.subscribe({ query }, { next: ({ data }) => resolve(data?.bump ?? data?.ok), error: reject, complete: () => {} })
  })

// A verifyToken that accepts the token when the connection is established, and refuses it afterwards, as if it had expired.
const verifiesOnce = () =>
  vi.fn<(host: string, token: string) => Promise<JwtPayload>>().mockResolvedValueOnce(claims).mockRejectedValue(new Error('jwt expired'))

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

  it('refuses an operation whose token no longer verifies, without running it or logging a server error', async () => {
    const { url, logger } = await startServer({ verifyToken: verifiesOnce(), requireAuth: true })

    await expect(bump(connect(url, { connectionParams: { Authorization: 'Bearer token-params' } }))).rejects.toMatchObject({ code: 4403 })

    expect(bumps).toBe(0)
    expect(logger.warn).toHaveBeenCalledWith('Subscription connection auth token is no longer valid', expect.anything())
    expect(logger.error).not.toHaveBeenCalledWith('GraphQL subscriptions server error', expect.anything())
  })

  it('logs an operation error with its id', async () => {
    const { url, logger } = await startServer({})
    const client = connect(url)

    await expect(
      new Promise((resolve, reject) =>
        client.subscribe({ query: 'subscription { nope }' }, { next: resolve, error: reject, complete: () => {} }),
      ),
    ).rejects.toBeDefined()

    expect(logger.error).toHaveBeenCalledWith('GraphQL subscriptions server error', {
      id: expect.any(String),
      errors: [expect.objectContaining({ message: 'Cannot query field "nope" on type "Subscription".' })],
    })
  })

  describe('allowQueriesAndMutations', () => {
    it.each(['query', 'mutation'] as const)(
      'refuses a %s operation by default, without running it or closing the connection',
      async (operationType) => {
        const { url, logger } = await startServer({})
        const client = connect(url)

        await expect(bump(client, operationType)).rejects.toMatchObject([{ extensions: { code: 'BAD_REQUEST' } }])

        expect(bumps).toBe(0)
        expect(logger.warn).toHaveBeenCalledWith(
          'Subscription connection refused a non-subscription operation',
          expect.objectContaining({ operationType }),
        )
        expect(logger.error).not.toHaveBeenCalledWith('GraphQL subscriptions server error', expect.anything())
        expect(await bump(client)).toBe(1)
      },
    )

    it('refuses the operation that operationName selects from a document that also has a subscription', async () => {
      const { url } = await startServer({})
      const client = connect(url)

      const result = new Promise((resolve, reject) => {
        client.subscribe(
          { query: 'subscription Watch { bump } mutation Bump { bump }', operationName: 'Bump' },
          { next: resolve, error: reject, complete: () => {} },
        )
      })

      await expect(result).rejects.toMatchObject([{ extensions: { code: 'BAD_REQUEST' } }])
      expect(bumps).toBe(0)
    })

    it('runs query and mutation operations when true', async () => {
      const { url } = await startServer({ allowQueriesAndMutations: true })
      const client = connect(url)

      expect(await bump(client, 'query')).toBe(true)
      expect(await bump(client, 'mutation')).toBe(1)
    })

    it.each([
      ['does not parse', 'mutation {', undefined, { code: 4500, reason: expect.stringContaining('Syntax Error') }],
      ['has no operation that operationName selects', 'mutation Bump { bump }', 'Nope', [{ message: 'Unable to identify operation' }]],
    ])('leaves a document that %s for graphql-ws to report', async (_case, query, operationName, expected) => {
      const { url, logger } = await startServer({})

      const result = new Promise((resolve, reject) => {
        connect(url).subscribe({ query, operationName }, { next: resolve, error: reject, complete: () => {} })
      })

      await expect(result).rejects.toMatchObject(expected)
      expect(bumps).toBe(0)
      expect(logger.warn).not.toHaveBeenCalledWith('Subscription connection refused a non-subscription operation', expect.anything())
    })
  })

  describe('connectionExpiry', () => {
    const bearer = { connectionParams: { Authorization: 'Bearer token-params' } }
    const endsIn = (ms: number) => () => Date.now() + ms

    it('is given the claims that verifyToken returned', async () => {
      const connectionExpiry = vi.fn(() => undefined)
      const { url } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry })

      await subscribeToToken(connect(url, bearer))

      expect(connectionExpiry).toHaveBeenCalledWith(claims)
    })

    it('closes the connection with 4403 at the time it returns, ending a running subscription', async () => {
      const { url, logger } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry: endsIn(1000) })

      const result = await watchTicks(connect(url, bearer), 3000)

      expect(result.closeCode).toBe(4403)
      expect(result.ticks).toBeGreaterThan(0)
      expect(logger.info).toHaveBeenCalledWith('Subscription connection expired', {
        claims: { oid: 'oid-1', iss: 'https://issuer.example' },
      })
    })

    it('refuses the connection, before acknowledging it, when that time has already passed', async () => {
      const { url, logger } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry: endsIn(-1000) })

      const result = await watchTicks(connect(url, bearer), 1000)

      expect(result).toEqual({ ticks: 0, closeCode: 4403 })
      expect(logger.warn).toHaveBeenCalledWith('Subscription connection has already expired', expect.anything())
      expect(logger.info).not.toHaveBeenCalledWith('Subscription connection established', expect.anything())
    })

    it('refuses the connection when it throws', async () => {
      const connectionExpiry = () => {
        throw new Error('no iat')
      }
      const { url, logger } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry })

      const result = await watchTicks(connect(url, bearer), 1000)

      expect(result).toEqual({ ticks: 0, closeCode: 4403 })
      expect(logger.error).toHaveBeenCalledWith('Failed to compute subscription connection expiry', expect.anything())
      expect(logger.info).not.toHaveBeenCalledWith('Subscription connection established', expect.anything())
    })

    it('lets the client subscribe again until then, without verifying the token again', async () => {
      const verifyToken = verifiesOnce()
      const { url } = await startServer({ verifyToken, requireAuth: true, connectionExpiry: endsIn(60_000) })
      const client = connect(url, bearer)

      expect(await subscribeToToken(client)).toBe('token-params')
      expect(await bump(client)).toBe(1)
      expect(verifyToken).toHaveBeenCalledTimes(1)
    })

    it('refuses an operation that arrives after that time, without running it', async () => {
      const endsAt = Date.now() + 60_000
      const { url, logger } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry: () => endsAt })
      const client = connect(url, bearer)
      await subscribeToToken(client)

      // Past the end, before the timer has fired.
      vi.spyOn(Date, 'now').mockReturnValue(endsAt)

      await expect(bump(client)).rejects.toMatchObject({ code: 4403 })
      expect(bumps).toBe(0)
      expect(logger.error).not.toHaveBeenCalledWith('GraphQL subscriptions server error', expect.anything())
    })

    it('verifies the token on each subscribe, as by default, when it returns undefined', async () => {
      const verifyToken = verifiesOnce()
      const { url } = await startServer({ verifyToken, requireAuth: true, connectionExpiry: () => undefined })

      await expect(subscribeToToken(connect(url, bearer))).rejects.toMatchObject({ code: 4403 })

      expect(verifyToken).toHaveBeenCalledTimes(2)
    })

    it('stops the timer when the client disconnects first', async () => {
      const { url, logger } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry: endsIn(1000) })
      const client = connect(url, bearer)

      await watchTicks(client, 50)
      await client.dispose()
      await delay(1100)

      expect(logger.info).toHaveBeenCalledWith('Subscription connection disconnected', expect.anything())
      expect(logger.info).not.toHaveBeenCalledWith('Subscription connection expired', expect.anything())
    })

    it('stops the timer when the client disconnects while a subscription waits for its next event', async () => {
      const { url, logger } = await startServer({ verifyToken: async () => claims, requireAuth: true, connectionExpiry: endsIn(1000) })
      const client = connect(url, bearer)

      await new Promise((resolve) =>
        client.subscribe({ query: 'subscription { stalls }' }, { next: resolve, error: resolve, complete: () => {} }),
      )
      await client.dispose()
      await delay(1100)

      expect(logger.info).not.toHaveBeenCalledWith('Subscription connection expired', expect.anything())
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
