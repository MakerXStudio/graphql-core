import { describe, expect, it, vi } from 'vitest'
import { wrapSubscriptionIterator } from './subscription-iterator'

const makeIterator = <T>(values: T[], options: { withReturn?: boolean; withThrow?: boolean } = {}) => {
  const { withReturn = true, withThrow = true } = options
  let index = 0
  const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined as T | undefined }))
  const throwSpy = vi.fn(async (err: unknown) => {
    throw err
  })
  const it: AsyncIterableIterator<T> = {
    next: async () => {
      if (index < values.length) return { done: false, value: values[index++] }
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  if (withReturn) it.return = returnSpy as AsyncIterableIterator<T>['return']
  if (withThrow) it.throw = throwSpy as AsyncIterableIterator<T>['throw']
  return { iterator: it, returnSpy, throwSpy }
}

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = []
  for await (const v of iterable) out.push(v)
  return out
}

describe('wrapSubscriptionIterator', () => {
  it('yields a single initial payload before wrapped events', async () => {
    const { iterator } = makeIterator([1, 2])
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: 0 })
    expect(await collect(wrapped)).toEqual([0, 1, 2])
  })

  it('yields an array initial payload in order before wrapped events', async () => {
    const { iterator } = makeIterator(['c', 'd'])
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: ['a', 'b'] })
    expect(await collect(wrapped)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('preserves falsy values in an array initial payload (regression: falsy values were dropped)', async () => {
    const { iterator } = makeIterator<number>([])
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: [1, 0, 2] })
    expect(await collect(wrapped)).toEqual([1, 0, 2])
  })

  it('yields a single falsy initial payload (regression: falsy single values were dropped)', async () => {
    const { iterator } = makeIterator<number>([1])
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: 0 })
    expect(await collect(wrapped)).toEqual([0, 1])
  })

  it('handles an empty array initial payload as a no-op', async () => {
    const { iterator } = makeIterator([1, 2])
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: [] })
    expect(await collect(wrapped)).toEqual([1, 2])
  })

  it('passes through events when no options are provided', async () => {
    const { iterator } = makeIterator([1, 2, 3])
    const wrapped = wrapSubscriptionIterator({ iterator })
    expect(await collect(wrapped)).toEqual([1, 2, 3])
  })

  it('ends iteration eagerly when eventIsFinal returns true and yields the final event', async () => {
    const { iterator } = makeIterator([1, 2, 3, 4])
    const wrapped = wrapSubscriptionIterator({
      iterator,
      eventIsFinal: (n) => n === 2,
    })
    expect(await collect(wrapped)).toEqual([1, 2])
  })

  it('calls wrapped.return() on eager end to release resources', async () => {
    const { iterator, returnSpy } = makeIterator([1, 2, 3])
    const wrapped = wrapSubscriptionIterator({
      iterator,
      eventIsFinal: (n) => n === 2,
    })
    await collect(wrapped)
    expect(returnSpy).toHaveBeenCalledTimes(1)
  })

  it('does not call wrapped.next() again after eager end', async () => {
    const { iterator } = makeIterator([1, 2, 3])
    const nextSpy = vi.spyOn(iterator, 'next')
    const wrapped = wrapSubscriptionIterator({
      iterator,
      eventIsFinal: (n) => n === 2,
    })
    const wrappedIterator = wrapped[Symbol.asyncIterator]()
    expect(await wrappedIterator.next()).toEqual({ done: false, value: 1 })
    expect(await wrappedIterator.next()).toEqual({ done: false, value: 2 })
    expect(await wrappedIterator.next()).toEqual({ done: true, value: undefined })
    expect(await wrappedIterator.next()).toEqual({ done: true, value: undefined })
    expect(nextSpy).toHaveBeenCalledTimes(2)
  })

  it('works with a wrapped iterator that omits return and throw (regression: non-null assertion crash)', async () => {
    const { iterator } = makeIterator([1, 2], { withReturn: false, withThrow: false })
    expect(() => wrapSubscriptionIterator({ iterator, initialPayload: 0 })).not.toThrow()
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: 0 })
    expect(await collect(wrapped)).toEqual([0, 1, 2])
  })

  it('does not throw on eager end when wrapped iterator omits return', async () => {
    const { iterator } = makeIterator([1, 2, 3], { withReturn: false })
    const wrapped = wrapSubscriptionIterator({
      iterator,
      eventIsFinal: (n) => n === 2,
    })
    await expect(collect(wrapped)).resolves.toEqual([1, 2])
  })

  it('delegates return() to the wrapped iterator and stops further iteration', async () => {
    const { iterator, returnSpy } = makeIterator(['x', 'y', 'z'])
    const wrapped = wrapSubscriptionIterator({ iterator, initialPayload: ['a', 'b'] })
    const it = wrapped[Symbol.asyncIterator]()
    expect(await it.next()).toEqual({ done: false, value: 'a' })
    await it.return!('early')
    expect(returnSpy).toHaveBeenCalledTimes(1)
    expect(await it.next()).toEqual({ done: true, value: undefined })
  })

  it('return() on a wrapper without wrapped.return resolves with done', async () => {
    const { iterator } = makeIterator([1, 2], { withReturn: false })
    const wrapped = wrapSubscriptionIterator({ iterator })
    const it = wrapped[Symbol.asyncIterator]()
    const result = await it.return!('stopped')
    expect(result.done).toBe(true)
  })

  it('throw() delegates to the wrapped iterator and stops further iteration', async () => {
    const { iterator, throwSpy } = makeIterator([1, 2])
    const wrapped = wrapSubscriptionIterator({ iterator })
    const it = wrapped[Symbol.asyncIterator]()
    const err = new Error('boom')
    await expect(it.throw!(err)).rejects.toBe(err)
    expect(throwSpy).toHaveBeenCalledWith(err)
    expect(await it.next()).toEqual({ done: true, value: undefined })
  })

  it('throw() on a wrapper without wrapped.throw rethrows', async () => {
    const { iterator } = makeIterator([1, 2], { withThrow: false })
    const wrapped = wrapSubscriptionIterator({ iterator })
    const it = wrapped[Symbol.asyncIterator]()
    const err = new Error('no-throw')
    await expect(it.throw!(err)).rejects.toBe(err)
  })

  it('does not apply eventIsFinal to entries in initialPayload', async () => {
    const { iterator } = makeIterator([1, 2])
    const isFinal = vi.fn((n: number) => n === 99)
    const wrapped = wrapSubscriptionIterator({
      iterator,
      initialPayload: [99, 100],
      eventIsFinal: isFinal,
    })
    expect(await collect(wrapped)).toEqual([99, 100, 1, 2])
    expect(isFinal).not.toHaveBeenCalledWith(99)
    expect(isFinal).not.toHaveBeenCalledWith(100)
  })

  it('is reusable as both AsyncIterator (manual next) and AsyncIterable (for-await)', async () => {
    const { iterator } = makeIterator([1, 2])
    const wrapped = wrapSubscriptionIterator({ iterator })
    expect(await wrapped.next()).toEqual({ done: false, value: 1 })
    expect(await wrapped.next()).toEqual({ done: false, value: 2 })
    expect(await wrapped.next()).toEqual({ done: true, value: undefined })
  })
})
