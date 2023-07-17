import { Logger } from '@makerx/node-common'
import { randomUUID } from 'crypto'
import type { Request } from 'express'
import pick from 'lodash.pick'
import { User } from './User'

export interface GraphQLContext<
  TLogger extends Logger = Logger,
  TRequestInfo extends BaseRequestInfo = RequestInfo,
  TUser = User | undefined,
> {
  logger: TLogger
  requestInfo: TRequestInfo
  user: TUser
  started: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGraphqlContext = GraphQLContext<any, any, any>

export interface BaseRequestInfo extends Record<string, unknown> {
  requestId: string
  protocol: 'http' | 'https' | 'ws'
  host: string
  method: string
  url: string
  origin: string
  referer?: string
  correlationId?: string
  arrLogId?: string
  clientIp?: string
}

export interface LambdaContext {
  functionName?: string
  awsRequestId?: string
}
export type LambdaEvent = never
export type LambdaRequestInfo = BaseRequestInfo & LambdaContext
export type RequestInfo = BaseRequestInfo | LambdaRequestInfo

// standard claims https://datatracker.ietf.org/doc/html/rfc7519#section-4.1
export interface JwtPayload {
  [key: string]: unknown
  name?: string | undefined
  email?: string | undefined
  given_name?: string | undefined
  family_name?: string | undefined
  preferred_username?: string | undefined
  upn?: string | undefined
  unique_name?: string | undefined
  oid?: string | undefined
  iss?: string | undefined
  sub?: string | undefined
  aud?: string | string[] | undefined
  roles?: string[] | undefined
  scp?: string | undefined
  exp?: number | undefined
  nbf?: number | undefined
  iat?: number | undefined
  jti?: string | undefined
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InferUserFromContext<TContext extends AnyGraphqlContext> = TContext extends GraphQLContext<any, any, infer TUser>
  ? TUser
  : never
export type CreateUser<T = User | undefined> = (input: Omit<ContextInput, 'createUser'>) => Promise<T> | T
export interface ContextInput {
  req: Request
  claims?: JwtPayload
  context?: LambdaContext
  event?: LambdaEvent
}
export type CreateContext<TContext = GraphQLContext> = (input: ContextInput) => Promise<TContext>
export type CreateRequestLogger = (requestMetadata: Record<string, unknown>) => Logger
export type AugmentRequestInfo = (input: ContextInput) => Record<string, unknown>

export interface CreateContextConfig<TContext extends AnyGraphqlContext = GraphQLContext> {
  requestLogger: CreateRequestLogger | Logger
  augmentRequestInfo?: AugmentRequestInfo
  claimsToLog?: string[]
  createUser: CreateUser<InferUserFromContext<TContext>>
  requestInfoToLog?: Array<keyof RequestInfo>
  augmentContext?: (context: TContext) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export const createContextFactory = <TContext extends AnyGraphqlContext = GraphQLContext>({
  requestLogger,
  augmentRequestInfo,
  claimsToLog,
  createUser,
  requestInfoToLog,
  augmentContext,
}: CreateContextConfig<TContext>): CreateContext<TContext> => {
  // the function that creates the GraphQL context
  return async (input: ContextInput) => {
    const { req, claims, context } = input

    // build base request info from the request
    const baseRequestInfo: BaseRequestInfo = {
      requestId: req.headers['x-request-id']?.toString() ?? randomUUID(),
      protocol: req.protocol as 'http' | 'https',
      host: req.get('Host') ?? '',
      method: req.method ?? '',
      url: req.originalUrl,
      origin: req.get('Origin') ?? '',
      referer: req.headers.referer?.toString() ?? '',
      arrLogId: req.headers['x-arr-log-id']?.toString() ?? undefined,
      clientIp: req.headers['x-forwarded-for']?.toString() ?? req.socket.remoteAddress,
      correlationId: req.headers['x-correlation-id']?.toString() ?? undefined,
    }

    // add lambda info from the context, if present
    let lambdaRequestInfo: LambdaRequestInfo | undefined
    if (context) {
      const { awsRequestId, functionName } = context
      lambdaRequestInfo = {
        awsRequestId,
        functionName,
        ...baseRequestInfo,
      }
    }

    // augment request info with the supplied function, if present
    let requestInfo: RequestInfo = lambdaRequestInfo ?? baseRequestInfo
    if (augmentRequestInfo)
      requestInfo = {
        ...requestInfo,
        ...augmentRequestInfo(input),
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
      user: createUser ? await createUser(input) : undefined,
      started: Date.now(),
    }

    const augmentedGraphQLContext = augmentContext
      ? { ...graphqlContext, ...(await augmentContext(graphqlContext as TContext)) }
      : graphqlContext

    return augmentedGraphQLContext as TContext
  }
}

export const defaultCreateUser: CreateUser<User | undefined> = ({ req, claims }) => {
  if (!claims) return Promise.resolve(undefined)
  const accessToken = req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization?.substring(7) ?? '' : ''
  return Promise.resolve(new User(claims, accessToken))
}
