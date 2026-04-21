import type { Logger } from '@makerx/node-common'
import { pick } from 'es-toolkit/compat'
import type { IncomingMessage } from 'http'
import { User } from '../User'
import type { CreateRequestLogger, GraphQLContext, JwtPayload, RequestInfo, RequestInfoLogKey } from '../context'
import { buildConnectRequestInfo } from '../request-info'
import { extractTokenFromConnectionParams } from './utils'

export interface SubscriptionContextInput {
  connectRequest: IncomingMessage
  connectionParams?: Readonly<Record<string, unknown>>
  claims?: JwtPayload
}

export type CreateSubscriptionUser<T = User | undefined> = (input: SubscriptionContextInput) => Promise<T> | T
export type CreateSubscriptionContext<TContext = GraphQLContext> = (input: SubscriptionContextInput) => Promise<TContext>
export type AugmentSubscriptionRequestInfo = (input: SubscriptionContextInput) => Record<string, unknown>

// `createUser` is optional when TUser is compatible with the default `User | undefined`
// (i.e. defaultCreateUser can satisfy it), and required when TUser is narrower.
export type CreateSubscriptionContextConfig<
  TUser = User | undefined,
  TAugment extends Record<string, unknown> = Record<string, never>,
  TLogger extends Logger = Logger,
> = {
  requestLogger: CreateRequestLogger<TUser, TLogger> | TLogger
  augmentRequestInfo?: AugmentSubscriptionRequestInfo
  claimsToLog?: string[]
  requestInfoToLog?: Array<RequestInfoLogKey>
  augmentContext?: (context: GraphQLContext<TLogger, RequestInfo, TUser>) => TAugment | Promise<TAugment>
} & ([User | undefined] extends [TUser] ? { createUser?: CreateSubscriptionUser<TUser> } : { createUser: CreateSubscriptionUser<TUser> })

export const createSubscriptionContextFactory = <
  TUser = User | undefined,
  TAugment extends Record<string, unknown> = Record<string, never>,
  TLogger extends Logger = Logger,
>(
  config: CreateSubscriptionContextConfig<TUser, TAugment, TLogger>,
): CreateSubscriptionContext<GraphQLContext<TLogger, RequestInfo, TUser> & TAugment> => {
  const { requestLogger, augmentRequestInfo, claimsToLog, requestInfoToLog, augmentContext } = config
  // The conditional type on CreateSubscriptionContextConfig guarantees `createUser` is provided
  // when TUser is narrower than `User | undefined`, so defaulting is sound here.
  const createUser = (config.createUser ?? defaultCreateUser) as CreateSubscriptionUser<TUser>

  return async (input: SubscriptionContextInput) => {
    const { connectRequest: req, claims } = input

    // build request info from the connect request and socket
    const requestInfo: RequestInfo = {
      ...buildConnectRequestInfo(req),
      ...augmentRequestInfo?.(input),
    }

    const user = await createUser(input)

    // create request logger
    let logger: TLogger
    if (typeof requestLogger === 'function') {
      // build request logger metadata
      const requestLoggerMetadata: Record<string, unknown> = {}
      // add request info to log
      if (requestInfoToLog?.length) requestLoggerMetadata.request = pick(requestInfo, requestInfoToLog)
      // add user claims to log
      if (claims && claimsToLog?.length) requestLoggerMetadata.user = pick(claims, claimsToLog)
      // build the request logger
      logger = requestLogger(requestLoggerMetadata, user)
    } else logger = requestLogger

    const graphqlContext: GraphQLContext<TLogger, RequestInfo, TUser> = {
      requestInfo,
      logger,
      user,
      started: Date.now(),
    }

    const augmentedGraphQLContext = augmentContext ? { ...graphqlContext, ...(await augmentContext(graphqlContext)) } : graphqlContext

    return augmentedGraphQLContext as GraphQLContext<TLogger, RequestInfo, TUser> & TAugment
  }
}

const defaultCreateUser: CreateSubscriptionUser<User | undefined> = ({ claims, connectionParams }) => {
  if (!claims) return Promise.resolve(undefined)
  const accessToken = extractTokenFromConnectionParams(connectionParams)
  return Promise.resolve(new User(claims, accessToken ?? ''))
}
