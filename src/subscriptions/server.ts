import type { Logger } from '@makerx/node-common'
import { pick } from 'es-toolkit/compat'
import type { GraphQLSchema } from 'graphql'
import { CloseCode } from 'graphql-ws'
import { useServer } from 'graphql-ws/use/ws'
import type { Server } from 'http'
import { WebSocketServer } from 'ws'
import type { GraphQLContext, JwtPayload } from '../context'
import { logSubscriptionOperation } from '../logging'
import type { CreateSubscriptionContext, ExtractSubscriptionToken } from './context'
import { defaultExtractSubscriptionToken, getHost } from './utils'

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
}) {
  if (requireAuth && !verifyToken) throw new Error('verifyToken must be supplied when requireAuth is true')

  const wsServer = new WebSocketServer({
    server: httpServer,
    path,
  })

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
  )
}
