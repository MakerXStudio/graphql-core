import { buildSchema, parse } from 'graphql'
import { describe, expect, it } from 'vitest'
import type { CollectDeprecatedElementUsageOptions, DeprecatedElementKind, DeprecatedElementUsage } from './deprecation'
import { collectDeprecatedElementUsage } from './deprecation'

/**
 * A schema owned by these tests. Every deprecation in a real schema exists to be removed, so
 * pointing this suite at one would make it fail the moment someone completes a migration it has
 * nothing to do with. These fixtures are permanent by construction.
 *
 * Deprecated fixtures, one per case the collector has to handle:
 * - `Widget.legacyName`: output field
 * - `Query.widget(legacyId:)`: field argument
 * - `@audit(legacyTag:)`: directive argument
 * - `WidgetFilterInput.legacyId`: input field, top level
 * - `WidgetFilterInput.legacyNested`: input field whose own type is an input object
 * - `NestedInput.legacyFlag`: input field one level down
 * - `TagInput.legacyLabel`: input field inside a list element
 * - `WidgetStatus.LEGACY_STATUS`: enum value, reachable as an argument, as an input field
 *   (`WidgetFilterInput.status`) and inside a list (`WidgetFilterInput.statuses`)
 */
const typeDefs = /* GraphQL */ `
  directive @audit(tag: String, legacyTag: String @deprecated(reason: "Use tag.")) on FIELD

  type Query {
    widget(id: ID, legacyId: ID @deprecated(reason: "Use id."), status: WidgetStatus): Widget
  }

  type Mutation {
    saveWidget(input: WidgetFilterInput!): Widget
    archiveWidget(input: ArchiveWidgetInput!): Widget
  }

  type Widget {
    id: ID
    name: String
    legacyName: String @deprecated(reason: "Use name.")
  }

  enum WidgetStatus {
    ACTIVE
    LEGACY_STATUS @deprecated(reason: "Use ACTIVE.")
  }

  input WidgetFilterInput {
    id: ID
    legacyId: ID @deprecated(reason: "Use id.")
    nested: NestedInput
    legacyNested: NestedInput @deprecated(reason: "Use nested.")
    tags: [TagInput!]
    status: WidgetStatus
    statuses: [WidgetStatus!]
  }

  input NestedInput {
    flag: Boolean
    legacyFlag: Boolean @deprecated(reason: "Use flag.")
    """
    Self-recursive so a test can nest deeper than the walk's depth cap.
    """
    child: NestedInput
  }

  input TagInput {
    label: String
    legacyLabel: String @deprecated(reason: "Use label.")
  }

  """
  Declares an input variable like saveWidget does, but with no legacyId, so a test can prove
  variables are attributed to the executed operation rather than every operation in the document.
  """
  input ArchiveWidgetInput {
    id: ID
    reason: String
  }
`

const schema = buildSchema(typeDefs)

type CollectOverrides = Omit<CollectDeprecatedElementUsageOptions, 'schema' | 'document'>

function collect(query: string, overrides: CollectOverrides = {}): DeprecatedElementUsage[] {
  return collectDeprecatedElementUsage({ schema, document: parse(query), ...overrides })
}

const names = (usages: DeprecatedElementUsage[]): string[] => usages.map((usage) => usage.name)

const ofKind = (usages: DeprecatedElementUsage[], kind: DeprecatedElementKind): DeprecatedElementUsage[] =>
  usages.filter((usage) => usage.kind === kind)

type NestedInput = { flag?: boolean | null; legacyFlag?: boolean | null; child?: NestedInput | null }

function nestChildren(depth: number): NestedInput {
  let node: NestedInput = { legacyFlag: true }
  for (let i = 0; i < depth; i++) node = { child: node }
  return node
}

/** Sends whatever `input` it is given as a variable — the shape real clients use. */
const saveWidgetViaVariable = /* GraphQL */ `
  mutation InputFieldViaVariables($input: WidgetFilterInput!) {
    saveWidget(input: $input) {
      name
    }
  }
`

describe('collectDeprecatedElementUsage', () => {
  it('the fixture schema still carries every deprecation these tests rely on', () => {
    // Guards against the suite silently going vacuous if a fixture loses its @deprecated directive,
    // and confirms buildSchema preserves @deprecated on argument and input field definitions.
    const deprecationOf = (typeName: string, fieldName: string): string | null | undefined => {
      const type = schema.getType(typeName)
      if (type == null || !('getFields' in type)) return undefined
      return type.getFields()[fieldName]?.deprecationReason
    }

    expect(deprecationOf('Widget', 'legacyName')).toBe('Use name.')
    expect(deprecationOf('WidgetFilterInput', 'legacyId')).toBe('Use id.')
    expect(deprecationOf('WidgetFilterInput', 'legacyNested')).toBe('Use nested.')
    expect(deprecationOf('NestedInput', 'legacyFlag')).toBe('Use flag.')
    expect(deprecationOf('TagInput', 'legacyLabel')).toBe('Use label.')

    const widgetField = schema.getQueryType()?.getFields().widget
    expect(widgetField?.args.find((arg) => arg.name === 'legacyId')?.deprecationReason).toBe('Use id.')

    expect(schema.getDirective('audit')?.args.find((arg) => arg.name === 'legacyTag')?.deprecationReason).toBe('Use tag.')

    const status = schema.getType('WidgetStatus')
    expect(status != null && 'getValue' in status ? status.getValue('LEGACY_STATUS')?.deprecationReason : undefined).toBe('Use ACTIVE.')

    // The replacements must NOT be deprecated, or the negative controls prove nothing.
    expect(status != null && 'getValue' in status ? (status.getValue('ACTIVE')?.deprecationReason ?? null) : undefined).toBeNull()
    expect(deprecationOf('Widget', 'name') ?? null).toBeNull()
    expect(widgetField?.args.find((arg) => arg.name === 'id')?.deprecationReason ?? null).toBeNull()
  })

  describe('elements found in the document', () => {
    it('records a deprecated output field', () => {
      const usages = collect(/* GraphQL */ `
        query OutputField {
          widget(id: "w1") {
            legacyName
          }
        }
      `)

      expect(usages).toEqual([
        { kind: 'output-field', name: 'Widget.legacyName', deprecationReason: 'Use name.', path: 'widget.legacyName' },
      ])
    })

    it('records a deprecated argument given a literal value', () => {
      const usages = collect(/* GraphQL */ `
        query ArgumentLiteral {
          widget(legacyId: "w1") {
            name
          }
        }
      `)

      expect(usages).toEqual([{ kind: 'argument', name: 'Query.widget(legacyId)', deprecationReason: 'Use id.', path: 'widget' }])
    })

    it('records a deprecated argument even when its value comes from a variable', () => {
      // The argument is named in the document (`legacyId: $legacyId`) even though its value is a
      // variable — precisely what an input-object field never is.
      const usages = collect(
        /* GraphQL */ `
          query ArgumentViaVariables($legacyId: ID) {
            widget(legacyId: $legacyId) {
              name
            }
          }
        `,
        { variables: { legacyId: 'w1' } },
      )

      expect(names(usages)).toEqual(['Query.widget(legacyId)'])
    })

    it('attributes a deprecated directive argument to the directive, not the enclosing field', () => {
      // TypeInfo resolves an argument against the enclosing directive when there is one, so without
      // an explicit branch this reports `Query.widget(legacyTag)` — an argument that does not exist.
      const usages = collect(/* GraphQL */ `
        query DirectiveArgument {
          widget(id: "w1") @audit(legacyTag: "x") {
            name
          }
        }
      `)

      expect(usages).toEqual([{ kind: 'directive-argument', name: '@audit(legacyTag)', deprecationReason: 'Use tag.', path: 'widget' }])
    })

    it('records nothing when the operation selects no deprecated element', () => {
      const usages = collect(/* GraphQL */ `
        query NoDeprecatedElements {
          widget(id: "w1") {
            name
          }
        }
      `)

      expect(usages).toEqual([])
    })

    it('records one entry when the same output field is selected under several aliases', () => {
      const usages = collect(/* GraphQL */ `
        query AliasedTwice {
          a: widget(id: "w1") {
            legacyName
          }
          b: widget(id: "w2") {
            legacyName
          }
        }
      `)

      expect(names(usages)).toEqual(['Widget.legacyName'])
    })
  })

  /**
   * Input fields are kept distinct from output fields because the two are different migrations and
   * can share a `<Type>.<field>` name. Anything querying this telemetry to decide whether a
   * deprecated element is safe to remove filters on exactly that value.
   */
  describe('deprecated input fields', () => {
    it('records an input field sent via variables', () => {
      const usages = collect(saveWidgetViaVariable, { variables: { input: { legacyId: 'w1' } } })

      expect(usages).toEqual([
        { kind: 'input-field', name: 'WidgetFilterInput.legacyId', deprecationReason: 'Use id.', path: '$input.legacyId' },
      ])
    })

    it('records an input field written inline in the document', () => {
      const usages = collect(/* GraphQL */ `
        mutation InputFieldInline {
          saveWidget(input: { legacyId: "w1" }) {
            name
          }
        }
      `)

      expect(usages).toEqual([
        { kind: 'input-field', name: 'WidgetFilterInput.legacyId', deprecationReason: 'Use id.', path: 'saveWidget.legacyId' },
      ])
    })

    it('records an input field alongside a deprecated output field on the same request', () => {
      const usages = collect(
        /* GraphQL */ `
          mutation InputFieldAndOutputField($input: WidgetFilterInput!) {
            saveWidget(input: $input) {
              legacyName
            }
          }
        `,
        { variables: { input: { legacyId: 'w1' } } },
      )

      // One request, two kinds — each under its own tag, so a field query and an input-field query
      // pick up one apiece rather than both landing in the same bucket.
      expect(names(ofKind(usages, 'output-field'))).toEqual(['Widget.legacyName'])
      expect(names(ofKind(usages, 'input-field'))).toEqual(['WidgetFilterInput.legacyId'])
    })

    it('records an input field explicitly sent as null — removing it would still break the caller', () => {
      const usages = collect(saveWidgetViaVariable, { variables: { input: { legacyId: null } } })

      expect(names(usages)).toEqual(['WidgetFilterInput.legacyId'])
    })

    it('records nothing when the input object omits the deprecated field', () => {
      const usages = collect(saveWidgetViaVariable, { variables: { input: { id: 'w1' } } })

      expect(usages).toEqual([])
    })

    it('records input fields nested below the variable type', () => {
      const usages = collect(saveWidgetViaVariable, {
        variables: { input: { nested: { legacyFlag: true }, legacyNested: { flag: true } } },
      })

      expect(usages).toEqual([
        { kind: 'input-field', name: 'NestedInput.legacyFlag', deprecationReason: 'Use flag.', path: '$input.nested.legacyFlag' },
        { kind: 'input-field', name: 'WidgetFilterInput.legacyNested', deprecationReason: 'Use nested.', path: '$input.legacyNested' },
      ])
    })

    it('records an input field inside a list element, with its index in the path', () => {
      const usages = collect(saveWidgetViaVariable, {
        variables: { input: { tags: [{ label: 'kept' }, { legacyLabel: 'gone' }] } },
      })

      expect(usages).toEqual([
        { kind: 'input-field', name: 'TagInput.legacyLabel', deprecationReason: 'Use label.', path: '$input.tags.1.legacyLabel' },
      ])
    })

    it('records one entry however many list elements carry the same field', () => {
      // Deduplicated per request: without it a 40-element list would emit 40 identical records,
      // letting one request flood the audit log.
      const usages = collect(saveWidgetViaVariable, {
        variables: { input: { tags: Array.from({ length: 40 }, (_, i) => ({ legacyLabel: `tag-${i}` })) } },
      })

      expect(names(usages)).toEqual(['TagInput.legacyLabel'])
    })

    it('records one entry when the same field arrives via both a variable and a document literal', () => {
      const usages = collect(
        /* GraphQL */ `
          mutation InputFieldFromBothSources($input: WidgetFilterInput!) {
            fromVariable: saveWidget(input: $input) {
              name
            }
            fromLiteral: saveWidget(input: { legacyId: "w1" }) {
              name
            }
          }
        `,
        { variables: { input: { legacyId: 'w1' } } },
      )

      expect(names(usages)).toEqual(['WidgetFilterInput.legacyId'])
    })

    it('walks variables against the executed operation, not every operation in the document', () => {
      // Both operations declare `$input`, with a different type each. `legacyId` is deprecated on
      // WidgetFilterInput and absent from ArchiveWidgetInput, so crediting the unexecuted one lies.
      const usages = collect(
        /* GraphQL */ `
          mutation SaveWidget($input: WidgetFilterInput!) {
            saveWidget(input: $input) {
              name
            }
          }

          mutation ArchiveWidget($input: ArchiveWidgetInput!) {
            archiveWidget(input: $input) {
              name
            }
          }
        `,
        // Deliberately carries a field ArchiveWidgetInput doesn't declare — that is the point.
        { variables: { input: { legacyId: 'w1' } }, operationName: 'ArchiveWidget' },
      )

      expect(usages).toEqual([])
    })
  })

  describe('operation scoping', () => {
    it('ignores literals belonging to an operation that was not executed', () => {
      const usages = collect(
        /* GraphQL */ `
          query Executed {
            widget(id: "w1") {
              name
            }
          }

          query NotExecuted {
            widget(legacyId: "w1") {
              legacyName
            }
          }
        `,
        { operationName: 'Executed' },
      )

      expect(usages).toEqual([])
    })

    it('ignores fragments reachable only from an operation that was not executed', () => {
      const usages = collect(
        /* GraphQL */ `
          query Executed {
            widget(id: "w1") {
              ...KeptFields
            }
          }

          query NotExecuted {
            widget(id: "w1") {
              ...LegacyFields
            }
          }

          fragment KeptFields on Widget {
            name
          }

          fragment LegacyFields on Widget {
            legacyName
          }
        `,
        { operationName: 'Executed' },
      )

      expect(usages).toEqual([])
    })

    it('reports elements reachable through a fragment used by the executed operation', () => {
      const usages = collect(
        /* GraphQL */ `
          query Executed {
            widget(id: "w1") {
              ...LegacyFields
            }
          }

          fragment LegacyFields on Widget {
            legacyName
          }
        `,
        { operationName: 'Executed' },
      )

      expect(names(usages)).toEqual(['Widget.legacyName'])
    })

    it('resolves the only operation in a document when no operation name is given', () => {
      const usages = collect(/* GraphQL */ `
        {
          widget(id: "w1") {
            legacyName
          }
        }
      `)

      expect(names(usages)).toEqual(['Widget.legacyName'])
    })
  })

  /**
   * Deprecated enum values reach the server the same two ways an input field does — as a document
   * literal, or as their name inside a variable — so both passes look for them.
   */
  describe('deprecated enum values', () => {
    it('records an enum value written as a literal in an argument', () => {
      const usages = collect(/* GraphQL */ `
        query EnumLiteralArgument {
          widget(status: LEGACY_STATUS) {
            name
          }
        }
      `)

      expect(usages).toEqual([{ kind: 'enum-value', name: 'WidgetStatus.LEGACY_STATUS', deprecationReason: 'Use ACTIVE.', path: 'widget' }])
    })

    it('records an enum value sent as a variable', () => {
      const usages = collect(
        /* GraphQL */ `
          query EnumViaVariable($status: WidgetStatus) {
            widget(status: $status) {
              name
            }
          }
        `,
        { variables: { status: 'LEGACY_STATUS' } },
      )

      expect(usages).toEqual([
        { kind: 'enum-value', name: 'WidgetStatus.LEGACY_STATUS', deprecationReason: 'Use ACTIVE.', path: '$status' },
      ])
    })

    it('records an enum value nested inside an input object sent as a variable', () => {
      const usages = collect(saveWidgetViaVariable, { variables: { input: { status: 'LEGACY_STATUS' } } })

      expect(usages).toEqual([
        { kind: 'enum-value', name: 'WidgetStatus.LEGACY_STATUS', deprecationReason: 'Use ACTIVE.', path: '$input.status' },
      ])
    })

    it('records an enum value inside a list, with its index in the path', () => {
      const usages = collect(saveWidgetViaVariable, { variables: { input: { statuses: ['ACTIVE', 'LEGACY_STATUS'] } } })

      expect(usages).toEqual([
        { kind: 'enum-value', name: 'WidgetStatus.LEGACY_STATUS', deprecationReason: 'Use ACTIVE.', path: '$input.statuses.1' },
      ])
    })

    it('records one entry however many list elements repeat the same value', () => {
      const usages = collect(saveWidgetViaVariable, {
        variables: { input: { statuses: Array.from({ length: 40 }, () => 'LEGACY_STATUS') } },
      })

      expect(names(usages)).toEqual(['WidgetStatus.LEGACY_STATUS'])
    })

    it('records a deprecated enum value used as a variable definition default', () => {
      const usages = collect(/* GraphQL */ `
        query EnumDefault($status: WidgetStatus = LEGACY_STATUS) {
          widget(status: $status) {
            name
          }
        }
      `)

      expect(names(usages)).toEqual(['WidgetStatus.LEGACY_STATUS'])
    })

    it('records nothing for a non-deprecated enum value', () => {
      expect(collect(saveWidgetViaVariable, { variables: { input: { status: 'ACTIVE' } } })).toEqual([])
    })

    it('records nothing for an enum name that is not in the schema', () => {
      // graphql-js rejects this at coercion, moments after the walk sees it; the walk must simply
      // not invent a record for a value the enum doesn't define.
      expect(collect(saveWidgetViaVariable, { variables: { input: { status: 'NOT_A_STATUS' } } })).toEqual([])
    })
  })

  describe('result shape', () => {
    it('carries the deprecation reason for every kind', () => {
      const usages = collect(
        /* GraphQL */ `
          mutation EveryKind($input: WidgetFilterInput!) {
            saveWidget(input: $input) @audit(legacyTag: "x") {
              legacyName
            }
            widget: saveWidget(input: { legacyId: "w1" }) {
              name
            }
          }
        `,
        { variables: { input: { status: 'LEGACY_STATUS' } } },
      )

      expect(usages.map(({ kind, deprecationReason }) => [kind, deprecationReason])).toEqual([
        ['directive-argument', 'Use tag.'],
        ['enum-value', 'Use ACTIVE.'],
        ['input-field', 'Use id.'],
        ['output-field', 'Use name.'],
      ])
    })

    it('orders results by kind then name, whatever order they were found in', () => {
      const usages = collect(
        /* GraphQL */ `
          query Ordering($status: WidgetStatus) {
            widget(legacyId: "w1", status: $status) {
              legacyName
            }
          }
        `,
        { variables: { status: 'LEGACY_STATUS' } },
      )

      expect(usages.map((usage) => usage.kind)).toEqual(['argument', 'enum-value', 'output-field'])
    })

    it('returns nothing for a schema with no deprecations at all', () => {
      const plainSchema = buildSchema(/* GraphQL */ `
        type Query {
          widget(id: ID): String
        }
      `)

      const usages = collectDeprecatedElementUsage({
        schema: plainSchema,
        document: parse(/* GraphQL */ `
          {
            widget(id: "w1")
          }
        `),
      })

      expect(usages).toEqual([])
    })
  })

  describe('limits', () => {
    it.each([
      ['records the deprecated field when nesting stays within the depth cap', 3, ['NestedInput.legacyFlag']],
      ['stops at the depth cap instead of recursing without bound', 200, []],
    ])('%s', (_label, depth, expected) => {
      // Input types can be self-recursive (NestedInput.child here), so a hand-crafted payload can
      // nest arbitrarily deep. The cap trades telemetry beyond that depth against blowing the stack.
      const usages = collect(saveWidgetViaVariable, { variables: { input: { nested: nestChildren(depth) } } })

      expect(names(usages)).toEqual(expected)
    })

    it('honours a non-default depth cap', () => {
      const variables = { input: { nested: nestChildren(3) } }

      expect(names(collect(saveWidgetViaVariable, { variables, maxVariableDepth: 2 }))).toEqual([])
      expect(names(collect(saveWidgetViaVariable, { variables, maxVariableDepth: 10 }))).toEqual(['NestedInput.legacyFlag'])
    })

    it('stops walking variables once the node budget is spent', () => {
      // The depth cap bounds how deep a payload goes, not how wide: a large flat list is shallow.
      const variables = { input: { tags: [{ legacyLabel: 'gone' }] } }

      expect(names(collect(saveWidgetViaVariable, { variables, maxVariableNodes: 1 }))).toEqual([])
      expect(names(collect(saveWidgetViaVariable, { variables }))).toEqual(['TagInput.legacyLabel'])
    })

    it('caps the number of elements returned', () => {
      const query = /* GraphQL */ `
        query Capped {
          widget(legacyId: "w1") {
            legacyName
          }
        }
      `

      expect(collect(query)).toHaveLength(2)
      expect(collect(query, { maxElements: 1 })).toHaveLength(1)
    })

    it('terminates on a self-referential variable value', () => {
      // A JSON request body can't express this, but an in-process caller can.
      const cyclic: Record<string, unknown> = {}
      cyclic.child = cyclic
      cyclic.legacyFlag = true

      expect(names(collect(saveWidgetViaVariable, { variables: { input: { nested: cyclic } } }))).toEqual(['NestedInput.legacyFlag'])
    })
  })

  describe('resilience', () => {
    it.each([
      ['a scalar where an input object is declared', 'not-an-object'],
      ['an array where an input object is declared', [{ legacyId: 'w1' }]],
      ['a number where an input object is declared', 42],
      ['a null where an input object is declared', null],
      ['a boolean where an enum is declared', true],
    ])('tolerates variables whose shape contradicts the declared type: %s', (_label, input) => {
      // The walk runs before graphql-js coerces variables, so mismatched shapes genuinely reach it.
      // It must record nothing rather than throw; a throw would turn the request into an error.
      expect(() => collect(saveWidgetViaVariable, { variables: { input } })).not.toThrow()
      expect(collect(saveWidgetViaVariable, { variables: { input } })).toEqual([])
    })

    it('ignores variables that the operation does not declare', () => {
      expect(collect(saveWidgetViaVariable, { variables: { input: { id: 'w1' }, stray: { legacyId: 'w1' } } })).toEqual([])
    })

    it('records nothing when no variables are supplied for a declared variable', () => {
      expect(collect(saveWidgetViaVariable)).toEqual([])
    })
  })
})
