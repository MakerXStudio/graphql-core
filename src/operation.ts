const anonOperationMatch = /(query|mutation|subscription)?(\s*)({)(\s*)(\w*)/im

export function extractAnonymousOperationName(source: string) {
  const match = source.match(anonOperationMatch)
  if (match && match[5]) {
    const type = match[1] ?? 'query'
    const name = match[5]
    return `${type} ${name}`
  }
  return undefined
}

export const isIntrospectionQuery = (query?: string) => query?.includes('__schema')
