import type { Logger } from '@makerx/node-common'
import type { GraphQLSchema } from 'graphql'
import { CloseCode } from 'graphql-ws'
import { useServer } from 'graphql-ws/lib/use/ws'
import type { Server } from 'http'
import { pick } from 'lodash'
import { WebSocketServer } from 'ws'
import type { JwtPayload } from '../context'
import { logSubscriptionOperation } from '../logging'
import type { CreateSubscriptionContext } from './context'
import { extractTokenFromConnectionParams, getHost } from './utils'

export function useSubscriptionsServer<TLogger extends Logger = Logger>({
  schema,
  httpServer,
  createSubscriptionContext,
  logger,
  operationLogLevel = 'info',
  path = '/graphql',
  verifyToken,
  requireAuth,
  jwtClaimsToLog = ['oid', 'iss'],
}: {
  schema: GraphQLSchema
  httpServer: Server
  createSubscriptionContext: CreateSubscriptionContext
  logger: TLogger
  operationLogLevel?: keyof TLogger
  path?: string
  verifyToken?: (host: string, token: string) => Promise<JwtPayload>
  requireAuth?: boolean
  jwtClaimsToLog?: string[]
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

        const token = extractTokenFromConnectionParams(ctx.connectionParams)
        if (!token) {
          if (requireAuth) {
            logger.error('No authorization parameter was supplied via websocket connection params')
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
        const token = extractTokenFromConnectionParams(ctx.connectionParams)
        if (!token) {
          if (requireAuth) {
            logger.error('No authorization parameter was supplied via websocket connection params')
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
      onOperation(_ctx, _message, args) {
        logSubscriptionOperation({ args, logLevel: operationLogLevel })
      },
      onNext(_ctx, _message, args, { data, ...result }) {
        logSubscriptionOperation({ args, logLevel: operationLogLevel, result })
      },
    },
    wsServer,
  )
}
