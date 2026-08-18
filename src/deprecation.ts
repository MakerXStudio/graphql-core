import type {
  ASTNode,
  DocumentNode,
  FieldNode,
  GraphQLInputType,
  GraphQLSchema,
  ObjectFieldNode,
  OperationDefinitionNode,
  VariableDefinitionNode,
} from 'graphql'
import {
  getNamedType,
  getOperationAST,
  isEnumType,
  isInputObjectType,
  isInputType,
  isListType,
  isNonNullType,
  Kind,
  separateOperations,
  typeFromAST,
  TypeInfo,
  visit,
  visitWithTypeInfo,
} from 'graphql'

/**
 * Safety valve for the variable walk. Recursion follows the schema's input types, which may be
 * mutually recursive, and variables are walked before graphql-js coerces them — so nothing else
 * bounds how deep a hand-crafted payload can go. Far above any real operation's nesting.
 */
export const DEFAULT_DEPRECATION_MAX_VARIABLE_DEPTH = 25

/**
 * Bounds the *breadth* of the variable walk, which the depth cap does not: a single large array of
 * small input objects is shallow but arbitrarily wide.
 */
export const DEFAULT_DEPRECATION_MAX_VARIABLE_NODES = 10_000

/**
 * Caps the collected result so one hostile document cannot blow up a log entry.
 */
export const DEFAULT_DEPRECATION_MAX_ELEMENTS = 50

const UNKNOWN = '<unknown>'

export type DeprecatedElementKind = 'output-field' | 'argument' | 'directive-argument' | 'input-field' | 'enum-value'

export interface DeprecatedElementUsage {
  kind: DeprecatedElementKind
  /**
   * Stable key for aggregating usage, formatted per kind:
   * `Type.field`, `Type.field(arg)`, `@directive(arg)`, `InputType.field`, `EnumType.VALUE`.
   */
  name: string
  /**
   * Best-effort location, for debugging a single record — not an aggregation key. A field selected
   * inside a fragment definition has no enclosing field in its ancestry, so its path is relative to
   * the fragment rather than the operation.
   */
  path?: string
}

export interface CollectDeprecatedElementUsageOptions {
  schema: GraphQLSchema
  document: DocumentNode
  /**
   * The executed operation. Resolved from `document` and `operationName` when omitted.
   */
  operation?: OperationDefinitionNode | null
  operationName?: string | null
  /**
   * Raw request variables, as supplied by the client and before graphql-js coerces them.
   */
  variables?: Record<string, unknown> | null
  maxVariableDepth?: number
  maxVariableNodes?: number
  maxElements?: number
}

export interface CollectDeprecatedElementUsageResult {
  elements: DeprecatedElementUsage[]
  /**
   * True when a limit — `maxElements`, `maxVariableDepth` or `maxVariableNodes` — stopped
   * collection before it finished, so `elements` may be missing elements the operation really used.
   * Absence from a truncated result is not evidence that an element is unused.
   */
  truncated: boolean
}

/**
 * Reports every `@deprecated` schema element an operation uses, across both the document and the
 * supplied variables.
 *
 * Output fields and arguments are named in the document, so an AST walk finds them. Input fields
 * and enum values are data the caller *supplies* rather than selects: they can arrive as a document
 * literal, or inside a variable where the name appears nowhere in the AST, so both routes are
 * walked and the results deduplicated.
 *
 * Results are deduplicated on kind and name — at most one entry per distinct element per request,
 * bounded by the size of the schema rather than the size of the request — and sorted, so records
 * are stable across requests.
 *
 * Returns `truncated` when any limit stopped collection. Absence from `elements` is only evidence
 * that an element went unused when `truncated` is false — which matters, because concluding
 * "nothing uses this" from a truncated result is how a still-used element gets deleted.
 *
 * The variable walk reads untrusted input before coercion, so a payload whose shape contradicts its
 * declared type reaches it. Every shape it depends on is guarded: malformed variables yield no
 * records rather than an error.
 *
 * This is request-side telemetry — it observes values a caller *sends*, never values the server
 * returns. A deprecated element that only ever appears in responses reads as unused.
 */
export function collectDeprecatedElementUsage({
  schema,
  document,
  operation,
  operationName,
  variables,
  maxVariableDepth = DEFAULT_DEPRECATION_MAX_VARIABLE_DEPTH,
  maxVariableNodes = DEFAULT_DEPRECATION_MAX_VARIABLE_NODES,
  maxElements = DEFAULT_DEPRECATION_MAX_ELEMENTS,
}: CollectDeprecatedElementUsageOptions): CollectDeprecatedElementUsageResult {
  const collected = new Map<string, DeprecatedElementUsage>()
  const walk: WalkState = { maxVariableDepth, remaining: maxVariableNodes, truncated: false }

  const collect = (usage: DeprecatedElementUsage): void => {
    const key = `${usage.kind}:${usage.name}`
    // Already recorded is deduplication, not truncation — only a rejected *new* element is a loss.
    if (collected.has(key)) return
    if (collected.size >= maxElements) {
      walk.truncated = true
      return
    }
    collected.set(key, usage)
  }

  const resolvedOperation = operation ?? getOperationAST(document, operationName ?? undefined)

  collectFromDocument(schema, scopeToOperation(document, resolvedOperation), collect)
  collectFromVariables(schema, resolvedOperation?.variableDefinitions, variables, walk, collect)

  return {
    elements: [...collected.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
    truncated: walk.truncated,
  }
}

type Collect = (usage: DeprecatedElementUsage) => void

/**
 * A document may carry several operations but only one runs, so anything the others select would be
 * reported as usage that never happened. `separateOperations` keeps each operation with only the
 * fragments it can reach, which is exactly the scope wanted here.
 */
function scopeToOperation(document: DocumentNode, operation: OperationDefinitionNode | null | undefined): DocumentNode {
  if (!operation) return document

  let operationCount = 0
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION) operationCount++
    if (operationCount > 1) return separateOperations(document)[operation.name?.value ?? ''] ?? document
  }
  return document
}

function collectFromDocument(schema: GraphQLSchema, document: DocumentNode, collect: Collect): void {
  const typeInfo = new TypeInfo(schema)

  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(_node, _key, _parent, _path, ancestors) {
        const field = typeInfo.getFieldDef()
        if (field?.deprecationReason == null) return
        collect({
          kind: 'output-field',
          name: `${typeInfo.getParentType()?.name ?? UNKNOWN}.${field.name}`,
          path: getPath(ancestors, field.name),
        })
      },
      Argument(_node, _key, _parent, _path, ancestors) {
        const argument = typeInfo.getArgument()
        if (argument?.deprecationReason == null) return
        // TypeInfo resolves an argument against the enclosing directive when there is one, so
        // without this branch a directive's argument is reported as an argument of the field the
        // directive is attached to — a field argument that does not exist.
        const directive = typeInfo.getDirective()
        collect({
          kind: directive ? 'directive-argument' : 'argument',
          name: directive
            ? `@${directive.name}(${argument.name})`
            : `${typeInfo.getParentType()?.name ?? UNKNOWN}.${typeInfo.getFieldDef()?.name ?? UNKNOWN}(${argument.name})`,
          path: getPath(ancestors),
        })
      },
      // Input-object fields written as literals in the document, including variable definition
      // default values, which TypeInfo also tracks as input positions.
      ObjectField(node, _key, _parent, _path, ancestors) {
        const parentType = getNamedType(typeInfo.getParentInputType())
        if (!isInputObjectType(parentType)) return
        const inputField = parentType.getFields()[node.name.value]
        if (inputField?.deprecationReason == null) return
        collect({
          kind: 'input-field',
          name: `${parentType.name}.${inputField.name}`,
          path: getPath(ancestors, inputField.name),
        })
      },
      EnumValue(node, _key, _parent, _path, ancestors) {
        const enumType = getNamedType(typeInfo.getInputType())
        if (!isEnumType(enumType)) return
        const enumValue = enumType.getValue(node.value)
        if (enumValue?.deprecationReason == null) return
        collect({
          kind: 'enum-value',
          name: `${enumType.name}.${enumValue.name}`,
          path: getPath(ancestors),
        })
      },
    }),
  )
}

type PathNode = FieldNode | ObjectFieldNode

function isPathNode(node: ASTNode): node is PathNode {
  return node.kind === Kind.FIELD || node.kind === Kind.OBJECT_FIELD
}

function getPath(ancestors: readonly (ASTNode | readonly ASTNode[])[], leaf?: string): string {
  const segments = ancestors
    .filter((x): x is ASTNode => !Array.isArray(x))
    .filter(isPathNode)
    .map((x) => x.name.value)

  if (leaf) segments.push(leaf)

  return segments.join('.')
}

interface WalkState {
  maxVariableDepth: number
  /** Remaining node budget, shared across every variable of the operation. */
  remaining: number
  truncated: boolean
}

/**
 * Walks each supplied variable value against its declared type, reporting every deprecated input
 * field and enum value the client actually sent.
 *
 * Takes the definitions of the *resolved* operation rather than scanning the whole document: the
 * same variable name may be declared with a different type in each operation, so only the executed
 * one's declarations describe the supplied values.
 */
function collectFromVariables(
  schema: GraphQLSchema,
  variableDefinitions: readonly VariableDefinitionNode[] | undefined,
  variables: Record<string, unknown> | null | undefined,
  state: WalkState,
  collect: Collect,
): void {
  if (variables == null) return

  for (const variableDefinition of variableDefinitions ?? []) {
    const variableName = variableDefinition.variable.name.value
    if (!Object.hasOwn(variables, variableName)) continue

    const type = typeFromAST(schema, variableDefinition.type)
    if (!isInputType(type)) continue

    walkInputValue(type, variables[variableName], `$${variableName}`, 0, state, collect)
  }
}

function walkInputValue(type: GraphQLInputType, value: unknown, path: string, depth: number, state: WalkState, collect: Collect): void {
  // A limit stopping the descent is a loss of telemetry, so it is recorded; a null value is simply
  // nothing to walk, and must not be reported as one.
  if (depth > state.maxVariableDepth || state.remaining <= 0) {
    state.truncated = true
    return
  }
  if (value == null) return
  state.remaining--

  // Unwrapped inline rather than by recursing, so a nullability wrapper doesn't spend a node from
  // the budget for a value that has not been descended into yet.
  const unwrapped = isNonNullType(type) ? type.ofType : type

  if (isListType(unwrapped)) {
    // GraphQL accepts a bare value in a list position, so handle both shapes.
    const items = Array.isArray(value) ? value : [value]
    for (const [index, item] of items.entries()) {
      // Checked here rather than relying on the recursive call returning early: the loop itself is
      // the unbounded part, since list length comes from the payload and each step builds a path.
      if (state.remaining <= 0) {
        state.truncated = true
        return
      }
      walkInputValue(unwrapped.ofType, item, Array.isArray(value) ? `${path}.${index}` : path, depth + 1, state, collect)
    }
    return
  }

  if (isEnumType(unwrapped)) {
    // An unknown name is a coercion error graphql-js raises moments later; nothing to record here.
    if (typeof value !== 'string') return
    const enumValue = unwrapped.getValue(value)
    if (enumValue?.deprecationReason != null) {
      collect({ kind: 'enum-value', name: `${unwrapped.name}.${enumValue.name}`, path })
    }
    return
  }

  // Scalars have no members that could carry a deprecation.
  if (!isInputObjectType(unwrapped) || !isRecord(value)) return

  for (const field of Object.values(unwrapped.getFields())) {
    if (state.remaining <= 0) {
      state.truncated = true
      return
    }
    if (!Object.hasOwn(value, field.name)) continue

    const fieldPath = `${path}.${field.name}`
    // Presence is the signal, explicit `null` included: a client still sending the field would
    // break if it were removed from the schema.
    if (field.deprecationReason != null) {
      collect({ kind: 'input-field', name: `${unwrapped.name}.${field.name}`, path: fieldPath })
    }

    walkInputValue(field.type, value[field.name], fieldPath, depth + 1, state, collect)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
