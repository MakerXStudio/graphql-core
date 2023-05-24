import { isLocalDev, Logger } from '@makerxstudio/node-common'
import { ExecutionArgs, GraphQLFormattedError, print } from 'graphql'
import omitBy from 'lodash.omitby'
import { isIntrospectionQuery, isNil } from './utils'
import { GraphQLContext } from './context'

interface GraphQLLogOperationInfo {
  started: number
  operationName?: string | null
  query?: string | null
  variables?: Record<string, unknown> | null
  result: {
    data?: Record<string, unknown> | null
    errors?: readonly GraphQLFormattedError[] | null
  }
  logger: Logger
}

export const logGraphQLOperation = ({ started, operationName, query, variables, result: { errors }, logger }: GraphQLLogOperationInfo) => {
  const isIntrospection = query && isIntrospectionQuery(query)
  if (isLocalDev && isIntrospection) return
  logger.info(
    'GraphQL operation',
    omitBy(
      {
        operationName,
        query: isIntrospection ? 'IntrospectionQuery' : query,
        variables: variables && Object.keys(variables).length > 0 ? variables : undefined,
        duration: Date.now() - started,
        errors,
      },
      isNil,
    ),
  )
}

/**
 * Logs `operationName`, `query` and `variables` params from the GraphQL `ExecutionArgs`.
 * If `args.contextValue` has a `logger` property, it will be used, otherwise the `logger` param will be used.
 */
export const logGraphQLExecutionArgs = (args: ExecutionArgs, message: string, logger?: Logger) => {
  const { operationName, variableValues, document } = args
  const contextLogger = (args.contextValue as Partial<GraphQLContext>).logger ?? logger
  contextLogger?.info(
    message,
    omitBy(
      {
        operationName,
        query: print(document),
        variables: variableValues,
      },
      isNil,
    ),
  )
}
