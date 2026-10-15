import type { Logger } from '@makerx/node-common'
import { pick } from 'es-toolkit/compat'
import { GraphQLError, type GraphQLSchema } from 'graphql'
import { CloseCode } from 'graphql-ws'
import { useServer } from 'graphql-ws/use/ws'
import type { Server } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { GraphQLContext, JwtPayload } from '../context'
import { logSubscriptionOperation } from '../logging'
import type { CreateSubscriptionContext, ExtractSubscriptionToken } from './context'
import { defaultExtractSubscriptionToken, getHost } from './utils'

// The longest delay setTimeout accepts. A connection that ends later than this is timed in steps.
const maxTimeoutMs = 2 ** 31 - 1

// What onSubscribe returns for an operation it refuses, so onError can tell a refusal from a real error.
class SubscriptionRefusedError extends GraphQLError {
  constructor() {
    super('Forbidden', { extensions: { code: 'FORBIDDEN' } })
  }
}

export function useSubscriptionsServer<TLogger extends Logger = Logger>({
  schema,
  httpServer,
  createSubscriptionContext,
  logger,
  operationLogLevel = 'info',
  path = '/graphql',
  verifyToken,
  extractToken = defaultExtractSubscriptionToken,
  requireAuth,
  jwtClaimsToLog = ['oid', 'iss'],
  resolveSubscriptionOperationLogger,
  includeDeprecatedElements,
  connectionExpiry,
  keepAlive = 12_000,
}: {
  schema: GraphQLSchema
  httpServer: Server
  createSubscriptionContext: CreateSubscriptionContext
  logger: TLogger
  operationLogLevel?: keyof TLogger
  path?: string
  verifyToken?: (host: string, token: string) => Promise<JwtPayload>
  /**
   * Returns the token to pass to `verifyToken`, e.g. from a JWT assertion header that a proxy adds
   * to the connect request. Defaults to the bearer token in the `authorization` or `Authorization`
   * connection parameter. Pass the same function to `createSubscriptionContextFactory`.
   */
  extractToken?: ExtractSubscriptionToken
  requireAuth?: boolean
  jwtClaimsToLog?: string[]
  resolveSubscriptionOperationLogger?: (context: GraphQLContext) => TLogger
  /**
   * If true, deprecated schema elements a subscription uses are collected and logged when it is
   * established. Not collected per emitted payload: the usage is a property of the operation.
   */
  includeDeprecatedElements?: boolean
  /**
   * Returns the time a connection ends, in milliseconds since the epoch, from the claims `verifyToken`
   * returned when it was established. `undefined` keeps the default behaviour below.
   *
   * When it returns a time:
   * - A time already past refuses the connection with `4403 Forbidden`, as an invalid token does.
   * - Otherwise at that time the connection is closed with `4403`, which ends every subscription
   *   running on it.
   * - Until then the client may subscribe again on the connection, and the token is not verified
   *   again: it was verified when the connection was established, and it cannot change for the life
   *   of the connection.
   *
   * To end a connection when its token expires: `(claims) => (claims.exp === undefined ? undefined : claims.exp * 1000)`.
   * When the token is short-lived proof of a longer session, such as an assertion that a proxy adds to
   * the upgrade request, a later time keeps subscriptions from being cut off every few minutes:
   * `(claims) => (claims.iat === undefined ? undefined : (claims.iat + 3600) * 1000)`. A connection then
   * outlives its token, so a revoked session is noticed only when the connection ends.
   *
   * By default a connection has no set end. Its token is verified again each time the client
   * subscribes, and a token that no longer verifies closes the connection with `4403` then.
   * Subscriptions already running continue until that happens.
   *
   * graphql-ws clients retry `4403` by default, but a retry succeeds only with a fresh token: the
   * client's `connectionParams` must be a function that returns a current token, or the upgrade
   * request must be authenticated afresh (by a cookie and a proxy, for example). A client that sends
   * the same expired token fails again until its `retryAttempts` run out, and its subscriptions then
   * end with an error.
   */
  connectionExpiry?: (claims: JwtPayload) => number | undefined
  /**
   * Milliseconds between the server's websocket pings. A connection that has not answered a ping by
   * the time the next one is due is terminated. `0` turns the pings off. Defaults to graphql-ws's 12
   * seconds.
   */
  keepAlive?: number
}) {
  if (requireAuth && !verifyToken) throw new Error('verifyToken must be supplied when requireAuth is true')

  const wsServer = new WebSocketServer({
    server: httpServer,
    path,
  })

  // When each connection ends, for the connections that connectionExpiry gave a time.
  const connectionEnds = new WeakMap<WebSocket, number>()

  const endConnectionAt = (socket: WebSocket, endsAt: number, claims: JwtPayload) => {
    // A client that went away while its token was being verified has already closed the socket.
    if (socket.readyState !== socket.OPEN) return
    connectionEnds.set(socket, endsAt)
    let timer: NodeJS.Timeout | undefined
    // The socket's own close event, not graphql-ws's onClose, which waits for every subscription on the connection to
    // return. A subscription waiting for its next event can hold that up indefinitely.
    socket.once('close', () => clearTimeout(timer))
    const schedule = () => {
      const remaining = endsAt - Date.now()
      timer = setTimeout(
        () => {
          if (remaining > maxTimeoutMs) return schedule()
          if (socket.readyState !== socket.OPEN) return
          logger.info('Subscription connection expired', { claims: pick(claims, jwtClaimsToLog) })
          socket.close(CloseCode.Forbidden, 'Forbidden')
        },
        Math.min(Math.max(remaining, 0), maxTimeoutMs),
      )
      timer.unref()
    }
    schedule()
  }

  // Closes the connection, and keeps graphql-ws from running the operation: it would run it after the
  // close if onSubscribe returned nothing.
  const refuse = (socket: WebSocket) => {
    socket.close(CloseCode.Forbidden, 'Forbidden')
    return [new SubscriptionRefusedError()]
  }

  return useServer(
    {
      schema,
      onError(_ctx, id, _payload, errors) {
        // A refusal is already logged, and is not a server error.
        if (errors.every((error) => error instanceof SubscriptionRefusedError)) return
        logger.error('GraphQL subscriptions server error', { id, errors })
      },
      onConnect: async (ctx) => {
        const connectionEstablished = 'Subscription connection established'
        if (!verifyToken) {
          logger.info(connectionEstablished)
          return true
        }

        const token = extractToken({ connectRequest: ctx.extra.request, connectionParams: ctx.connectionParams })
        if (!token) {
          if (requireAuth) {
            logger.error('No auth token was supplied with the websocket connection')
            return false
          }
          logger.info(connectionEstablished)
          return true
        }

        let claims: JwtPayload
        try {
          claims = await verifyToken(getHost(ctx.extra.request), token)
        } catch (error) {
          logger.error('Failed to verify subscription connection auth token', { error })
          return false
        }

        let endsAt: number | undefined
        try {
          endsAt = connectionExpiry?.(claims)
        } catch (error) {
          logger.error('Failed to compute subscription connection expiry', { claims: pick(claims, jwtClaimsToLog), error })
          return false
        }
        // Refused before the connection is acknowledged: an acknowledged connection resets a graphql-ws
        // client's retry count, so closing it at once would have the client reconnect without end.
        if (endsAt !== undefined && !(endsAt > Date.now())) {
          logger.warn('Subscription connection has already expired', { claims: pick(claims, jwtClaimsToLog) })
          return false
        }

        ctx.extra.claims = claims as unknown as undefined
        logger.info(connectionEstablished, {
          claims: pick(claims, jwtClaimsToLog),
        })
        if (endsAt !== undefined) endConnectionAt(ctx.extra.socket, endsAt, claims)
        return true
      },
      onSubscribe: async (ctx) => {
        if (!verifyToken) return
        const endsAt = connectionEnds.get(ctx.extra.socket)
        if (endsAt !== undefined) {
          // The token stands for the life connectionExpiry gave the connection. This covers an operation that
          // arrives before the timer closes the connection.
          if (Date.now() < endsAt) return
          logger.warn('Subscription connection has expired', { claims: pick(ctx.extra.claims, jwtClaimsToLog) })
          return refuse(ctx.extra.socket)
        }
        const token = extractToken({ connectRequest: ctx.extra.request, connectionParams: ctx.connectionParams })
        if (!token) {
          if (requireAuth) {
            logger.error('No auth token was supplied with the websocket connection')
            return refuse(ctx.extra.socket)
          }
          return
        }
        try {
          await verifyToken(getHost(ctx.extra.request), token)
        } catch (error) {
          logger.warn('Subscription connection auth token is no longer valid', { claims: pick(ctx.extra.claims, jwtClaimsToLog), error })
          return refuse(ctx.extra.socket)
        }
      },
      onDisconnect({ extra: { claims } }) {
        logger.info('Subscription connection disconnected', { claims: pick(claims, jwtClaimsToLog) })
      },
      context: async (ctx) => {
        return createSubscriptionContext({
          connectRequest: ctx.extra.request,
          connectionParams: ctx.connectionParams,
          claims: ctx.extra.claims as JwtPayload | undefined,
        })
      },
      onOperation(_ctx, id, _payload, args) {
        logSubscriptionOperation({
          id,
          args,
          logLevel: operationLogLevel,
          resolveLogger: resolveSubscriptionOperationLogger,
          includeDeprecatedElements,
        })
      },
      onNext(_ctx, id, _payload, args, { data, ...result }) {
        logSubscriptionOperation({ id, args, logLevel: operationLogLevel, result, resolveLogger: resolveSubscriptionOperationLogger })
      },
    },
    wsServer,
    keepAlive,
  )
}
