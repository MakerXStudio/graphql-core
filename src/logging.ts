import { isLocalDev, Logger } from '@makerx/node-common'
import { ExecutionArgs, GraphQLFormattedError, OperationTypeNode, print } from 'graphql'
import { ExecutionResult } from 'graphql-ws'
import omitBy from 'lodash.omitby'
import { GraphQLContext } from './context'
import { isIntrospectionQuery, isNil } from './utils'

interface GraphQLLogOperationInfo<TLogger extends Logger = Logger> {
  message?: string
  started?: number
  type?: OperationTypeNode | null
  operationName?: string | null
  query?: string | null
  variables?: Record<string, unknown> | null
  result?: {
    data?: Record<string, unknown> | null
    errors?: readonly GraphQLFormattedError[] | null
    hasNext?: boolean
  }
  logger: TLogger
  logLevel?: keyof TLogger
}

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
  logLevel?: keyof TLogger
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
