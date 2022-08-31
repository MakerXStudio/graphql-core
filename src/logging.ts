import { isLocalDev, Logger } from '@makerxstudio/node-common'
import { GraphQLFormattedError } from 'graphql'
import isNil from 'lodash.isnil'
import omitBy from 'lodash.omitby'
import { isIntrospectionQuery } from './utils'

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
  const isIntrospection = query && isIntrospectionQuery({ operationName, query })
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
      isNil
    )
  )
}
