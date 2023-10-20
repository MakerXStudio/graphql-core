import { isLocalDev, Logger } from '@makerx/node-common'
import { ExecutionArgs, GraphQLFormattedError, OperationTypeNode, print } from 'graphql'
import { ExecutionResult } from 'graphql-ws'
import omitBy from 'lodash.omitby'
import { GraphQLContext } from './context'
import { isIntrospectionQuery, isNil } from './utils'

export type LoggerLogFunctions<T extends Logger> = {
  [Property in keyof T]: (message: string, ...optionalParams: unknown[]) => void
}

/**
 * Info for logging a GraphQL operation in a consistent format with the option of including any additional data.
 */
export interface GraphQLLogOperationInfo<TLogger extends Logger = Logger> extends Record<string, unknown> {
  /**
   * The message to log, defaults to 'GraphQL operation'.
   */
  message?: string
  /**
   * The timestamp when the operation started, if supplied, the duration will be logged.
   */
  started?: number
  /**
   * The type of GraphQL operation.
   */
  type?: OperationTypeNode | null
  /**
   * The name of the GraphQL operation.
   */
  operationName?: string | null
  /**
   * The formatted GraphQL query.
   */
  query?: string | null
  /**
   * The GraphQL variables.
   */
  variables?: Record<string, unknown> | null
  /**
   * The result of the GraphQL operation.
   * Generally, we don't log the data or extensions, just errors.
   */
  result?: {
    data?: Record<string, unknown> | null
    errors?: readonly GraphQLFormattedError[] | null
    extensions?: Record<string, unknown> | null
    hasNext?: boolean
  }
  /**
   * Whether the operation is an introspection query.
   */
  isIntrospectionQuery?: boolean
  /**
   * Whether the operation is part of an incremental response.
   */
  isIncrementalResponse?: boolean
  /**
   * Whether the operation is a subsequent payload of an incremental response.
   */
  isSubsequentPayload?: boolean
  /**
   * The logger to use.
   */
  logger: TLogger
  /**
   * The logger function to use, defaults to 'info'.
   */
  logLevel?: keyof LoggerLogFunctions<TLogger>
}

/**
 * Logs a GraphQL operation in a consistent format with the option of including any additional data.
 * Top level and result entries with null or undefined values will be omitted.
 */
export const logGraphQLOperation = <TLogger extends Logger = Logger>({
  message = 'GraphQL operation',
  started,
  type,
  operationName,
  query,
  variables,
  result,
  logger,
  logLevel = 'info',
  ...rest
}: GraphQLLogOperationInfo<TLogger>) => {
  const isIntrospection = query && isIntrospectionQuery(query)
  if (isLocalDev && isIntrospection) return
  logger[logLevel as keyof Logger](
    message,
    omitBy(
      {
        type,
        operationName,
        query,
        variables: variables && Object.keys(variables).length > 0 ? variables : undefined,
        duration: started ? Date.now() - started : undefined,
        result: result ? omitBy(result, isNil) : undefined,
        isIntrospectionQuery: isIntrospection || undefined,
        ...omitBy(rest, isNil),
      },
      isNil,
    ),
  )
}

export const logSubscriptionOperation = <TLogger extends Logger = Logger>({
  args,
  result,
  message,
  logLevel,
}: {
  args: ExecutionArgs
  result?: ExecutionResult
  message?: string
  logLevel?: keyof LoggerLogFunctions<TLogger>
}) => {
  const logger = (args.contextValue as GraphQLContext).logger as TLogger
  if (!logger) return

  const { operationName, variableValues, document } = args
  const { data, ...resultWithoutData } = result ?? {}

  logGraphQLOperation({
    message,
    type: OperationTypeNode.SUBSCRIPTION,
    operationName,
    query: print(document),
    variables: variableValues,
    result: resultWithoutData,
    logger,
    logLevel,
  })
}
