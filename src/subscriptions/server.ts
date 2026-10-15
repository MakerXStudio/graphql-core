import type { Logger } from '@makerx/node-common'
import { pick } from 'es-toolkit/compat'
import type { GraphQLSchema } from 'graphql'
import { CloseCode } from 'graphql-ws'
import { useServer } from 'graphql-ws/use/ws'
import type { Server } from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import type { GraphQLContext, JwtPayload } from '../context'
import { logSubscriptionOperation } from '../logging'
import type { CreateSubscriptionContext, ExtractSubscriptionToken } from './context'
import { defaultExtractSubscriptionToken, getHost } from './utils'

// The longest delay setTimeout accepts. A token that expires later than this is timed in steps.
const maxTimeoutMs = 2 ** 31 - 1

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
  closeOnTokenExpiry,
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
   * If true, a connection is closed with `4403 Forbidden` when its token expires, which ends every
   * subscription running on it. The expiry is the `exp` claim that `verifyToken` returned when the
   * connection was established: the token cannot change for the life of a connection, whether it
   * arrives in the connection params or on the upgrade request. A connection without a token, or whose
   * claims have no `exp`, is not timed.
   *
   * graphql-ws clients retry `4403` by default, but a retry succeeds only with a fresh token: the
   * client's `connectionParams` must be a function that returns a current token, or the upgrade
   * request must be authenticated afresh (by a cookie and a proxy, for example). A client that sends
   * the same expired token fails again until its `retryAttempts` run out, and its subscriptions then
   * end with an error.
   *
   * Without it, an expired token is refused only when the client next subscribes on the connection,
   * and subscriptions already running continue.
   */
  closeOnTokenExpiry?: boolean
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

  const closeAtExpiry = (socket: WebSocket, claims: JwtPayload) => {
    // A client that went away while its token was being verified has already closed the socket.
    if (typeof claims.exp !== 'number' || socket.readyState !== socket.OPEN) return
    const expiresAt = claims.exp * 1000
    let timer: NodeJS.Timeout | undefined
    // The socket's own close event, not graphql-ws's onClose, which waits for every subscription on the connection to
    // return. A subscription waiting for its next event can hold that up indefinitely.
    socket.once('close', () => clearTimeout(timer))
    const schedule = () => {
      const remaining = expiresAt - Date.now()
      timer = setTimeout(
        () => {
          if (remaining > maxTimeoutMs) return schedule()
          if (socket.readyState !== socket.OPEN) return
          logger.info('Subscription connection auth token expired', { claims: pick(claims, jwtClaimsToLog) })
          socket.close(CloseCode.Forbidden, 'Forbidden')
        },
        Math.min(Math.max(remaining, 0), maxTimeoutMs),
      )
      timer.unref()
    }
    schedule()
  }

  return useServer(
    {
      schema,
      onError(_ctx, message, errors) {
        logger.error('GraphQL subscriptions server error', { message, errors })
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

        try {
          const claims = await verifyToken(getHost(ctx.extra.request), token)
          ctx.extra.claims = claims as unknown as undefined
          logger.info(connectionEstablished, {
            claims: pick(claims, jwtClaimsToLog),
          })
          if (closeOnTokenExpiry) closeAtExpiry(ctx.extra.socket, claims)
          return true
        } catch (error) {
          logger.error('Failed to verify subscription connection auth token', { error })
          return false
        }
      },
      onSubscribe: async (ctx) => {
        if (!verifyToken) return
        const token = extractToken({ connectRequest: ctx.extra.request, connectionParams: ctx.connectionParams })
        if (!token) {
          if (requireAuth) {
            logger.error('No auth token was supplied with the websocket connection')
            ctx.extra.socket.close(CloseCode.Forbidden, 'Forbidden')
          }
          return
        }
        try {
          await verifyToken(getHost(ctx.extra.request), token)
        } catch (error) {
          logger.warn('Subscription connection auth token is no longer valid', { claims: pick(ctx.extra.claims, jwtClaimsToLog), error })
          ctx.extra.socket.close(CloseCode.Forbidden, 'Forbidden')
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
