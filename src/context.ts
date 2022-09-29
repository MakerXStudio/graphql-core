import { Logger } from '@makerxstudio/node-common'
import { randomUUID } from 'crypto'
import type { Request } from 'express'
import pick from 'lodash.pick'
import { User } from './User'

export interface GraphQLContext<TLogger extends Logger = Logger, TRequestInfo extends BaseRequestInfo = RequestInfo> {
  logger: TLogger
  requestInfo: TRequestInfo
  user?: User
  started: number
}

export interface BaseRequestInfo extends Record<string, unknown> {
  requestId: string
  host: string
  method: string
  url: string
  referer: string
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

export interface ContextInput {
  req: Request
  user?: JwtPayload
  context?: LambdaContext
  event?: LambdaEvent
}
export type CreateContext<TContext = GraphQLContext> = (input: ContextInput) => TContext

export type RequestLoggerFactory = (requestMetadata: Record<string, unknown>) => Logger
export type AugmentRequestInfo = (input: ContextInput) => Record<string, unknown>

export interface CreateContextConfig<TContext = GraphQLContext> {
  requestLogger: RequestLoggerFactory | Logger
  augmentRequestInfo?: AugmentRequestInfo
  userClaimsToLog?: string[]
  requestInfoToLog?: Array<keyof RequestInfo>
  augmentContext?: (context: TContext) => Record<string, unknown>
}

export const createContextFactory = <TContext extends GraphQLContext = GraphQLContext>({
  requestLogger,
  augmentRequestInfo,
  userClaimsToLog,
  requestInfoToLog,
  augmentContext,
}: CreateContextConfig<TContext>): CreateContext<TContext> => {
  // the function that creates the GraphQL context
  return (input: ContextInput) => {
    const { req, user: claims, context } = input

    // build base request info from the request
    const baseRequestInfo: BaseRequestInfo = {
      requestId: req.headers['x-request-id']?.toString() ?? randomUUID(),
      protocol: req.protocol,
      host: req.get('Host') ?? '',
      method: req.method ?? '',
      url: req.originalUrl,
      referer: req.headers.referer ?? '',
      arrLogId: req.headers['x-arr-log-id']?.toString() ?? undefined,
      clientIp: req.headers['x-forwarded-for']?.toString() ?? undefined,
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
      if (claims && userClaimsToLog?.length) requestLoggerMetadata.user = pick(claims, userClaimsToLog)
      // build the request logger
      logger = requestLogger(requestLoggerMetadata)
    } else logger = requestLogger

    // build the User class
    const accessToken = req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization?.substring(7) ?? '' : ''
    const user = claims ? new User(claims, accessToken) : undefined

    const graphqlContext: GraphQLContext = {
      requestInfo,
      logger,
      user,
      started: Date.now(),
    }

    const augmentedGraphQLContext = augmentContext ? { ...graphqlContext, ...augmentContext(graphqlContext as TContext) } : graphqlContext

    return augmentedGraphQLContext as TContext
  }
}
