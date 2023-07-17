import { GraphQLScalarType, GraphQLSchema } from 'graphql'

/**
 * It is possible to register a custom scalar with apollo server without defining an explicit resolver (a default resolver is used in
 * this case), but it is rarely desirable. This function, when provided with your built schema, will ensure any registered scalar types
 * provide at least a base level of validation by failing to parse a Symbol instance. The default resolver does not pass this test
 * meaning any scalars that are falling back to the default resolver will fail.
 * @param schema A schema object, the result of calling `makeExecutableSchema` from `@graphql-tools/schema`
 */
export function requireExplicitResolversForScalars(schema: GraphQLSchema) {
  const testSymbol = Symbol('testSymbol')
  const scalars = Object.values(schema.getTypeMap()).filter((t): t is GraphQLScalarType => t instanceof GraphQLScalarType)
  for (const scalar of scalars) {
    if (scalar.name === 'Void') continue
    try {
      scalar.parseValue(testSymbol)
    } catch {
      // We expect that a parser should not handle parsing a symbol
      continue
    }
    throw new Error(
      `Scalar ${scalar.name} does not appear to have an explicit resolver, or is not performing sufficient validation when parsing input`,
    )
  }
}
