export type Primitive = string | number | symbol | bigint | boolean | null | undefined | Date

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScalarPropsInternal<T, TKey extends keyof T, TAdditionalScalars = never> = TKey extends any
  ? T[TKey] extends Primitive | TAdditionalScalars
    ? TKey
    : never
  : never
export type ScalarProps<T, TAdditionalScalars = never> = Pick<T, ScalarPropsInternal<T, keyof T, TAdditionalScalars>>
