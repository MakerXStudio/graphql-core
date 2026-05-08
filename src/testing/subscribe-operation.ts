import type { TypedDocumentNode } from '@graphql-typed-document-node/core'
import { parse, subscribe, type DocumentNode, type ExecutionResult, type GraphQLSchema } from 'graphql'
import type { AnyGraphqlContext } from '../context'

export type VariableValues = { [key: string]: any }

export type TypedSubscribeRequest<TData = Record<string, unknown>, TVariables extends VariableValues = VariableValues> = {
  subscription: string | DocumentNode | TypedDocumentNode<TData, TVariables>
  variables?: TVariables
  operationName?: string
}

/**
 * Returns a `subscribeOperation` test helper for the provided schema and context creation function.
 *
 * The returned function runs a subscription operation directly against the schema using `graphql.subscribe`,
 * bypassing the websocket / `graphql-ws` transport. This gives tests complete control over JWT payloads
 * and other context inputs, the same way `buildExecuteOperation` does for queries and mutations in
 * `@makerx/graphql-apollo-server/testing`.
 *
 * The returned function:
 * - is strongly typed to the GraphQL context
 * - accepts `TypedDocumentNode` subscriptions to provide strong operation typing
 * - forwards any additional arguments to the supplied context creation function
 * - returns the subscription's `AsyncIterableIterator<ExecutionResult<TData>>` so tests can consume events via `for await` or manual `next()` calls
 * - throws if the subscription fails to produce an iterator (e.g. a validation error), surfacing the underlying errors
 *
 * @param schema The executable `GraphQLSchema`, or a factory that resolves one (useful when schema construction is async).
 * @param createContext A context creation function. Any args supplied after the request are forwarded to it,
 *   so test fixtures can drive auth/user state per-call (e.g. `(jwtPayload?) => Promise<GraphQLContext>`).
 */
export function buildSubscribeOperation<TContext extends AnyGraphqlContext, TContextFunction extends (...args: any) => Promise<TContext>>(
  schema: GraphQLSchema | (() => Promise<GraphQLSchema>),
  createContext: TContextFunction,
) {
  return async function subscribeOperation<TData = Record<string, unknown>, TVariables extends VariableValues = VariableValues>(
    { subscription, variables, operationName }: TypedSubscribeRequest<TData, TVariables>,
    ...createContextArgs: Parameters<TContextFunction>
  ): Promise<AsyncIterableIterator<ExecutionResult<TData>>> {
    const resolvedSchema = typeof schema === 'function' ? await schema() : schema
    const document = typeof subscription === 'string' ? parse(subscription) : subscription
    const contextValue = await createContext(...createContextArgs)
    const result = await subscribe({
      schema: resolvedSchema,
      document,
      contextValue,
      variableValues: variables as VariableValues | undefined,
      operationName,
    })
    if (Symbol.asyncIterator in result) return result as AsyncIterableIterator<ExecutionResult<TData>>
    throw new Error(`Subscription did not produce an iterator: ${JSON.stringify((result as ExecutionResult).errors)}`)
  }
}
