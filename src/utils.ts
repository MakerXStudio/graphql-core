export const isIntrospectionQuery = ({ operationName, query }: { operationName?: string | null; query?: string | null }) =>
  operationName === 'IntrospectionQuery' || query?.includes('__schema')
