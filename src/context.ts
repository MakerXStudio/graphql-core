import type { Logger } from '@makerx/node-common'
import { pick } from 'es-toolkit/compat'
import type { Request } from 'express'
import { buildBaseRequestInfo, type BaseRequestInfo } from './request-info'
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

export type AnyGraphqlContext = GraphQLContext<any, any, any>

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

export type InferUserFromContext<TContext extends AnyGraphqlContext> =
  TContext extends GraphQLContext<any, any, infer TUser> ? TUser : never
export type CreateUser<T = User | undefined> = (input: Omit<ContextInput, 'createUser'>) => Promise<T> | T
export interface ContextInput {
  req: Request
  claims?: JwtPayload
  context?: LambdaContext
  event?: LambdaEvent
}
export type CreateContext<TContext = GraphQLContext> = (input: ContextInput) => Promise<TContext>
export type CreateRequestLogger<TUser = User | undefined, TLogger extends Logger = Logger> = (
  requestMetadata: Record<string, unknown>,
  user: TUser,
) => TLogger
export type AugmentRequestInfo = (input: ContextInput) => Record<string, unknown>

// `createUser` is optional when TUser is compatible with the default `User | undefined`
// (i.e. `defaultCreateUser` can satisfy it), and required when TUser is narrower.
export type CreateContextConfig<
  TUser = User | undefined,
  TAugment extends Record<string, unknown> = Record<string, never>,
  TLogger extends Logger = Logger,
> = {
  requestLogger: CreateRequestLogger<TUser, TLogger> | TLogger
  augmentRequestInfo?: AugmentRequestInfo
  claimsToLog?: string[]
  requestInfoToLog?: Array<keyof RequestInfo>
  augmentContext?: (context: GraphQLContext<TLogger, RequestInfo, TUser>) => TAugment | Promise<TAugment>
} & ([User | undefined] extends [TUser] ? { createUser?: CreateUser<TUser> } : { createUser: CreateUser<TUser> })

export const createContextFactory = <
  TUser = User | undefined,
  TAugment extends Record<string, unknown> = Record<string, never>,
  TLogger extends Logger = Logger,
>(
  config: CreateContextConfig<TUser, TAugment, TLogger>,
): CreateContext<GraphQLContext<TLogger, RequestInfo, TUser> & TAugment> => {
  const { requestLogger, augmentRequestInfo, claimsToLog, requestInfoToLog, augmentContext } = config
  // The conditional type on CreateContextConfig guarantees `createUser` is provided when TUser is
  // narrower than `User | undefined`, so defaulting to defaultCreateUser is sound here.
  const createUser = (config.createUser ?? defaultCreateUser) as CreateUser<TUser>

  return async (input: ContextInput) => {
    const { req, claims, context } = input

    // build base request info from the request
    const baseRequestInfo: BaseRequestInfo = buildBaseRequestInfo(req)

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

export const defaultCreateUser: CreateUser<User | undefined> = ({ req, claims }) => {
  if (!claims) return Promise.resolve(undefined)
  const accessToken = req.headers.authorization?.startsWith('Bearer') ? (req.headers.authorization?.substring(7) ?? '') : ''
  return Promise.resolve(new User(claims, accessToken))
}
