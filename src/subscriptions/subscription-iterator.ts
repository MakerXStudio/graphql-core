/**
 * Wraps an async iterator with options for:
 *  - returning an initial payload (e.g. current state)
 *  - eagerly ending iteration when a final event is received
 *
 * Providing an initial payload helps avoid race conditions when clients subscribe to events but miss recent state changes,
 *  by providing an initial payload to be immediately returned, before subsequent events stream in.
 *
 * Eagerly ending iteration when a final event ensures subscriptions do not continue unnecessarily.
 *
 * @param iterator The async iterator to wrap.
 * @param initialPayload An optional initial payload to return on the first iteration. May be a single event or an array.
 * @param eventIsFinal An optional function to determine if an event is final (and iteration should end).
 *   The full `initialPayload` is always yielded; `eventIsFinal` is only checked against its final entry, after which
 *   the wrapped iterator is closed without ever being pulled from. For events from the wrapped iterator, every event
 *   is checked.
 * @returns An async iterator for the event data.
 */
export function wrapSubscriptionIterator<TEventData>({
  iterator: wrapped,
  initialPayload,
  eventIsFinal,
}: {
  iterator: AsyncIterableIterator<TEventData>
  initialPayload?: TEventData | TEventData[]
  eventIsFinal?: (event: TEventData) => boolean
}): AsyncIterator<TEventData> & AsyncIterable<TEventData> {
  let done = false
  const initialQueue: TEventData[] =
    initialPayload === undefined ? [] : Array.isArray(initialPayload) ? [...initialPayload] : [initialPayload]

  const iterator: AsyncIterator<TEventData> = {
    next: async () => {
      if (done) return { done: true, value: undefined }

      if (initialQueue.length > 0) {
        const value = initialQueue.shift() as TEventData
        if (initialQueue.length === 0 && eventIsFinal && eventIsFinal(value)) {
          done = true
          await wrapped.return?.()
        }
        return { done: false, value }
      }

      const next = await wrapped.next()
      if (!next.done && eventIsFinal && eventIsFinal(next.value)) {
        done = true
        await wrapped.return?.()
      }
      return next
    },
    return: async (value) => {
      done = true
      initialQueue.length = 0
      if (wrapped.return) return wrapped.return(value)
      return { done: true, value: value as TEventData }
    },
    throw: async (err) => {
      done = true
      initialQueue.length = 0
      if (wrapped.throw) return wrapped.throw(err)
      throw err
    },
  }

  return { ...iterator, [Symbol.asyncIterator]: () => iterator }
}
