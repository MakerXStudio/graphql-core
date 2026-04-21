import type { Logger } from '@makerx/node-common'
import { pick } from 'es-toolkit/compat'
import type { IncomingMessage } from 'http'
import { User } from '../User'
import type { CreateRequestLogger, GraphQLContext, JwtPayload, RequestInfo } from '../context'
import { buildConnectRequestInfo } from '../request-info'
import { extractTokenFromConnectionParams } from './utils'

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

    // build request info from the connect request and socket
    const requestInfo: RequestInfo = {
      ...buildConnectRequestInfo(req),
      ...augmentRequestInfo?.(input),
    }

    const user = await createUser(input)

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
      logger = requestLogger(requestLoggerMetadata, user)
    } else logger = requestLogger

    const graphqlContext: GraphQLContext = {
      requestInfo,
      logger,
      user,
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
  const accessToken = extractTokenFromConnectionParams(connectionParams)
  return Promise.resolve(new User(claims, accessToken ?? ''))
}
