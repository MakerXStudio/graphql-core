import { describe, expect, it } from 'vitest'
import { extractAnonymousOperationName, isIntrospectionQuery } from './operation'

describe('extractAnonymousOperationName', () => {
  it('defaults to "query" when no operation keyword is present', () => {
    expect(extractAnonymousOperationName('{ users { id } }')).toBe('query users')
  })

  it('uses the explicit query keyword', () => {
    expect(extractAnonymousOperationName('query { users { id name } }')).toBe('query users')
  })

  it('uses the explicit mutation keyword', () => {
    expect(extractAnonymousOperationName('mutation { createUser { id } }')).toBe('mutation createUser')
  })

  it('uses the explicit subscription keyword', () => {
    expect(extractAnonymousOperationName('subscription { onUpdate { id } }')).toBe('subscription onUpdate')
  })

  it('tolerates extra whitespace around braces and field name', () => {
    expect(extractAnonymousOperationName('mutation   {    createThing   { id } }')).toBe('mutation createThing')
  })

  it('handles operation declarations spanning multiple lines', () => {
    const source = `query {
      users {
        id
      }
    }`
    expect(extractAnonymousOperationName(source)).toBe('query users')
  })

  it('is case-insensitive on the operation keyword and preserves source casing', () => {
    expect(extractAnonymousOperationName('MUTATION { doThing { id } }')).toBe('MUTATION doThing')
  })

  it('returns undefined when there is no top-level field after the brace', () => {
    expect(extractAnonymousOperationName('{ }')).toBeUndefined()
  })

  it('returns undefined when the source contains no opening brace', () => {
    expect(extractAnonymousOperationName('not a graphql operation')).toBeUndefined()
  })

  it('returns undefined for an empty source', () => {
    expect(extractAnonymousOperationName('')).toBeUndefined()
  })
})

describe('isIntrospectionQuery', () => {
  it('returns true when the query references __schema', () => {
    expect(isIntrospectionQuery('query IntrospectionQuery { __schema { types { name } } }')).toBe(true)
  })

  it('returns false for an ordinary query', () => {
    expect(isIntrospectionQuery('query { users { id } }')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isIntrospectionQuery('')).toBe(false)
  })

  it('returns undefined when no query is provided', () => {
    expect(isIntrospectionQuery(undefined)).toBeUndefined()
  })
})
