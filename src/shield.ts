import type { allow, and, chain, IRules, or, race } from 'graphql-shield'
import { rule, shield } from 'graphql-shield'
import type { GraphQLContext } from './context'
import type { Primitive } from './type-utils'

export type ShieldOptions = NonNullable<Parameters<typeof shield>[1]>

type RuleCombinator = typeof chain | typeof race | typeof or | typeof and
// For whatever reason, graphql-shield doesn't export this type, but we can extract if from
// what it does export.
export type ShieldRule = ReturnType<(typeof allow)['getRules']>[number]

/**
 * Thin typed wrapper around graphql-shield's `rule(...)` for building ad-hoc shield rules.
 *
 * Lets you pass a plain predicate (sync or async, or returning an `Error`) and get back a
 * {@link ShieldRule} with the `parent`, `args`, and `ctx` arguments typed to your generics —
 * graphql-shield's native `rule` types these as `any`.
 *
 * Defaults the rule's cache to `'strict'`; use `'contextual'` when the result depends only on
 * `ctx` (e.g. the current user), so it can be reused across fields in the same request.
 *
 * @param logic Predicate returning `true` to allow, `false` to deny, or an `Error` to deny with a specific error.
 * @param cache graphql-shield cache strategy. `'strict'` (default) keys on parent+args+ctx; `'contextual'` keys on ctx only.
 *
 * Usage:
 *
 * const isOwner = createRule<GraphQLContext, { ownerId: string }>(
 *   (parent, _, ctx) => parent.ownerId === ctx.user?.id,
 * )
 */
export const createRule = <TContext, TParent = unknown, TArgs = unknown>(
  logic: (parent: TParent, args: TArgs, ctx: TContext) => boolean | Promise<boolean> | Error,
  cache: 'contextual' | 'strict' = 'strict',
): ShieldRule => rule({ cache })(async (parent, args, ctx) => logic(parent, args, ctx))

/**
 * Combines a given rule with all existing defined rules using the provided combinator
 * @param schema The existing shield schema with rules
 * @param rule The rule to be combined with existing rules
 * @param combinator The combinator to use. Eg. and | or | chain | race
 *
 * Usage:
 *
 * const updatedSchema = combineRuleWithAll(shieldSchema, rules.accountNotBlocked, chain)
 */
export function combineRuleWithAll<T>(schema: ShieldSchema<T>, rule: ShieldRule, combinator: RuleCombinator): ShieldSchema<T> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (value.constructor.name !== 'Object') {
        return [key, combinator(rule, value)]
      }
      return [key, combineRuleWithAll(value, rule, combinator)]
    }),
  ) as ShieldSchema<T>
}

/**
 * Creates graphql shield middleware making use of generics to type the definition of the rules.
 * @param schema A mapping of schema objects to the shield rules that define the access to that object
 * @param options Shield options forwarded to `shield`. Defaults `allowExternalErrors` to `true`.
 *
 * Usage:
 * import { Resolvers } from '../generated/types'
 *
 * const isCoordinator = hasRoleRule(UserRoles.Coordinator)
 * const isSystemAdmin = hasRoleRule(UserRoles.SystemAdmin)
 * const isQualityAssurance = hasRoleRule(UserRoles.QualityAssurance)
 *
 * const isAuthorisedUser = or(isCoordinator, isSystemAdmin, isQualityAssurance)
 * const isDataAuthor = or(isCoordinator, isSystemAdmin)
 *
 * const shieldSchema = createShieldSchema<Resolvers>({
 *   Query: {
 *     '*': isAuthorisedUser,
 *     user: isCoordinator,
 *     findUsers: isCoordinator,
 *   },
 *   Mutation: {
 *     '*': isDataAuthor,
 *     createUser: isCoordinator,
 *   },
 *   // specific rules for mutations, types, fields...
 * }, { fallbackRule: isAuthorisedUser, fallbackError: unauthorisedError()})
 *
 * const unprotected = makeExecutableSchema({...})
 * return applyMiddleware(unprotected, shieldSchema)
 */
export function createShieldSchema<TRootResolvers>(schema: ShieldSchema<TRootResolvers>, options?: ShieldOptions) {
  return shield(schema as IRules, {
    allowExternalErrors: true,
    ...options,
  })
}

/**
 * A shield rule tree typed against a resolver map (typically your generated `Resolvers` type).
 *
 * Mirrors the shape of `TResolver` so each type/field can be assigned a {@link ShieldRule}.
 * Object levels may also include a `'*'` key — a fallback rule applied to any field at that
 * level that doesn't have an explicit rule. Leaf (primitive) positions collapse to a single
 * {@link ShieldRule}.
 *
 * Usage:
 *
 * const schema: ShieldSchema<Resolvers> = {
 *   Query: {
 *     '*': isAuthorisedUser,
 *     publicThing: allow,
 *   },
 *   Mutation: { createUser: isCoordinator },
 * }
 */
export type ShieldSchema<TResolver> = TResolver extends Primitive
  ? ShieldRule
  : {
      [key in keyof TResolver]?: ShieldSchema<TResolver[key]> | ShieldRule
    } & {
      '*'?: ShieldRule
    }

/**
 * Shield rule that passes when the current user has the given role.
 * @param role The role the user must have on `ctx.user.roles`.
 * @param ruleName Optional override for the rule's cache key. Defaults to `hasRole-${role}`.
 */
export function hasRoleRule(role: string, ruleName?: string): ShieldRule {
  return rule(ruleName ?? `hasRole-${role}`, { cache: 'contextual' })(
    (_, __, { user }: GraphQLContext) => user?.roles.includes(role) === true,
  )
}

/**
 * Shield rule that passes when the current user has at least one of the given roles.
 * Rule name is derived from the roles; use {@link hasAnyRoleRuleWithName} to supply your own.
 * @param roles The set of roles, any of which satisfies the rule.
 */
export function hasAnyRoleRule(...roles: string[]): ShieldRule {
  return hasAnyRoleRuleWithName(`hasAnyRole-${roles.join(',')}`, ...roles)
}

/**
 * Shield rule that passes when the current user has at least one of the given roles, with an explicit rule name.
 * Prefer this over {@link hasAnyRoleRule} when the role list is large or dynamic and you want a stable cache key.
 * @param ruleName The name (and cache key) for the rule.
 * @param roles The set of roles, any of which satisfies the rule.
 */
export function hasAnyRoleRuleWithName(ruleName: string, ...roles: string[]): ShieldRule {
  return rule(ruleName, { cache: 'contextual' })((_, __, { user }: GraphQLContext) => {
    return user?.roles.some((role: string) => roles.includes(role)) === true
  })
}

/**
 * Shield rule that passes when the current user has the given scope.
 * @param scope The scope the user must have on `ctx.user.scopes`.
 */
export function hasScopeRule(scope: string): ShieldRule {
  return rule(`hasScope-${scope}`, { cache: 'contextual' })((_, __, { user }: GraphQLContext) => user?.scopes.includes(scope) === true)
}

/**
 * Shield rule that passes when the current user has at least one of the given scopes.
 * @param scopes The set of scopes, any of which satisfies the rule.
 */
export function hasAnyScopeRule(...scopes: string[]): ShieldRule {
  return rule(`hasAnyScope-${scopes.join(',')}`, { cache: 'contextual' })(
    (_, __, { user }: GraphQLContext) => user?.scopes.some((scope: string) => scopes.includes(scope)) === true,
  )
}
