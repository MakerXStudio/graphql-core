export const isIntrospectionQuery = (query?: string) => query?.includes('__schema')
export const isNil = (value: unknown): value is null | undefined => value === null || value === undefined
export const isNotNil = <T>(value: T): value is Exclude<T, undefined | null> => !isNil(value)
