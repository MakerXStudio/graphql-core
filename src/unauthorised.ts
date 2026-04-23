import { GraphQLError } from 'graphql'

/**
 * Builds a `GraphQLError` representing an authorization failure.
 *
 * Sets the Apollo-standard `FORBIDDEN` extension code and an HTTP 403 status, so clients and
 * gateways that inspect `extensions.code` / `extensions.http.status` see a consistent shape.
 *
 * @param message Error message shown to the client. Defaults to `'Not Authorized!'`.
 */
export const unauthorisedError = (message: string = 'Not Authorized!') =>
  new GraphQLError(message, {
    extensions: { code: 'FORBIDDEN', http: { status: 403 } },
  })

/**
 * Throws an {@link unauthorisedError}. Return type is `never` so TypeScript narrows control flow past the call.
 * @param message Optional override for the error message.
 */
export function throwUnauthorised(message?: string): never {
  throw unauthorisedError(message)
}

/**
 * Assertion helper: throws an {@link unauthorisedError} when `hasPermission` is false, otherwise narrows it to `true`.
 *
 * Use at the top of resolvers or services to fail fast on authorization checks while keeping
 * the happy path unindented.
 *
 * @param hasPermission Boolean guard; the function returns normally only when this is `true`.
 * @param message Optional override for the error message thrown on failure.
 *
 * Usage:
 *
 * permissionInvariant(ctx.user?.id === record.ownerId, 'Only the owner can edit this record')
 * // past this line, TypeScript knows the condition held
 */
export function permissionInvariant(hasPermission: boolean, message?: string): asserts hasPermission {
  if (!hasPermission) throwUnauthorised(message)
}
