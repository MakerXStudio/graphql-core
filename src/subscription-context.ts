import type { Logger } from '@makerxstudio/node-common'
import { randomUUID } from 'crypto'
import type { IncomingMessage } from 'http'
import type { JwtPayload } from 'jsonwebtoken'
import { pick } from 'lodash'
import { User } from './User'
import { CreateRequestLogger, GraphQLContext, RequestInfo } from './context'

export interface SubscriptionContextInput {
  connectRequest: IncomingMessage
  connectionParams?: Readonly<Record<string, unknown>>
  claims?: JwtPayload
}

export type CreateSubscriptionUser<T = User | undefined> = (input: SubscriptionContextInput) => Promise<T>
export type CreateSubscriptionContext<TContext = GraphQLContext> = (input: SubscriptionContextInput) => Promise<TContext>
export type AugmentSubscriptionRequestInfo = (input: SubscriptionContextInput) => Record<string, unknown>

export interface CreateSubscriptionContextConfig<TContext = GraphQLContext> {
  requestLogger: CreateRequestLogger | Logger
  augmentRequestInfo?: AugmentSubscriptionRequestInfo
  claimsToLog?: string[]
  createUser?: CreateSubscriptionUser
  requestInfoToLog?: Array<keyof RequestInfo>
  augmentContext?: (context: TContext) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export const createSubscriptionContextFactory = <TContext extends GraphQLContext = GraphQLContext>({
  requestLogger,
  augmentRequestInfo,
  claimsToLog,
  createUser = defaultCreateUser,
  requestInfoToLog,
  augmentContext,
}: CreateSubscriptionContextConfig<TContext>): CreateSubscriptionContext<TContext> => {
  // the function that creates the GraphQL context
  return async (input: SubscriptionContextInput) => {
    const { connectRequest: req, claims } = input

    const xForwardedFor = req.headers['x-forwarded-for']
    const host = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor ?? req.headers.host

    // build request info from the connect request and socket
    const requestInfo: RequestInfo = {
      requestId: req.headers['x-request-id']?.toString() ?? randomUUID(),
      protocol: 'ws',
      host: host ?? '',
      method: req.method ?? '',
      url: req.url ?? '',
      origin: req.headers['origin'] ?? '',
      referer: req.headers.referer?.toString() ?? '',
      arrLogId: req.headers['x-arr-log-id']?.toString() ?? undefined,
      clientIp: req.headers['x-forwarded-for']?.toString() ?? req.socket.remoteAddress,
      correlationId: req.headers['x-correlation-id']?.toString() ?? undefined,
      ...augmentRequestInfo?.(input),
    }

    // create request logger
    let logger: Logger
    if (typeof requestLogger === 'function') {
      // build request logger metadata
      const requestLoggerMetadata: Record<string, unknown> = {}
      // add request info to log
      if (requestInfoToLog?.length) requestLoggerMetadata.request = pick(requestInfo, requestInfoToLog)
      // add user claims to log
      if (claims && claimsToLog?.length) requestLoggerMetadata.user = pick(claims, claimsToLog)
      // build the request logger
      logger = requestLogger(requestLoggerMetadata)
    } else logger = requestLogger

    const graphqlContext: GraphQLContext = {
      requestInfo,
      logger,
      user: await createUser(input),
      started: Date.now(),
    }

    const augmentedGraphQLContext = augmentContext
      ? { ...graphqlContext, ...(await augmentContext(graphqlContext as TContext)) }
      : graphqlContext

    return augmentedGraphQLContext as TContext
  }
}

const defaultCreateUser: CreateSubscriptionUser<User | undefined> = ({ claims, connectionParams }) => {
  if (!claims) return Promise.resolve(undefined)
  const authParam = connectionParams?.authorization as string | undefined
  const accessToken = authParam?.startsWith('Bearer') ? authParam.substring(7) : ''
  return Promise.resolve(new User(claims, accessToken))
}
