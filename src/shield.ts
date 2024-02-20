import type { and, chain, or, race } from 'graphql-shield'
import { allow, rule, shield } from 'graphql-shield'
import type { IRules } from 'graphql-shield'
import type { Primitive } from './models'

type RuleCombinator = typeof chain | typeof race | typeof or | typeof and
// For whatever reason, graphql-shield doesn't export this type, but we can extract if from
// what it does export.
export type ShieldRule = ReturnType<(typeof allow)['getRules']>[number]
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
 * @param fallbackRule A fallback rule to apply to any object or property which doesn't have a defined rule.
 *
 * Usage:
 * import { Resolvers } from '../generated/types'
 *
 * const shieldSchema = createShieldSchema<Resolvers>({
 *   Query: {
 *     getThings: allow,
 *     dontGetThings: deny,
 *   }
 * })
 *
 * let schema = makeExecutableSchema({...})
 *
 * schema = applyMiddleware(schema, shieldSchema)
 */
export function createShieldSchema<TRootResolvers>(schema: ShieldSchema<TRootResolvers>, fallbackRule: ShieldRule = allow) {
  return shield(schema as IRules, {
    allowExternalErrors: true,
    fallbackRule: fallbackRule,
  })
}

export type ShieldSchema<TResolver> = TResolver extends Primitive
  ? ShieldRule
  : {
      [key in keyof TResolver]?: ShieldSchema<TResolver[key]> | ShieldRule
    } & {
      '*'?: ShieldRule
    }
