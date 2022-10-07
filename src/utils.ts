export const isIntrospectionQuery = (query?: string) => query?.includes('__schema')

export const compact = <T = unknown>(...sparse: Array<T | undefined>): Array<T> =>
  sparse.filter((item) => item !== undefined && item !== null) as Array<T>
