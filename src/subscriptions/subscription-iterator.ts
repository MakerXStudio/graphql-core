/**
 * A function that lazily produces an initial payload. Provided in place of a plain value when the
 * caller needs the wrapped iterator's subscription to be established *before* the payload is read.
 */
export type InitialPayloadFactory<TEventData> = () => TEventData | TEventData[] | Promise<TEventData | TEventData[]>

/**
 * An initial payload: a single event, an array of events, or a factory that produces either.
 *
 * Note: the factory form is detected via `typeof initialPayload === 'function'`. If `TEventData` is
 * itself a callable type, a value-form payload would be misclassified as a factory — wrap such a value
 * in an array (`[value]`) to disambiguate. GraphQL event payloads are objects, so this is not a concern
 * in practice.
 */
export type InitialPayload<TEventData> = TEventData | TEventData[] | InitialPayloadFactory<TEventData>

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
 * ### Avoiding the subscribe-before-snapshot race
 *
 * `graphql-subscriptions`' iterator subscribes to its channel lazily, on its first `next()`. If you read the
 * snapshot (the initial payload) *before* constructing/pulling the iterator, any event published between the
 * snapshot read and the subscription going live is lost — and missing from the snapshot too. To close that
 * window, pass `initialPayload` as a **factory** (`() => ... | Promise<...>`). When a factory is supplied this
 * helper eagerly pulls the wrapped iterator once (establishing the subscription) *before* invoking the factory
 * to read the snapshot; events fired during the snapshot read are then buffered by the wrapped iterator instead
 * of dropped, and are delivered immediately after the snapshot.
 *
 * @param iterator The async iterator to wrap.
 * @param initialPayload An optional initial payload to return on the first iteration. May be a single event, an
 *   array, or a factory (`() => event | event[] | Promise<event | event[]>`). Prefer the factory form for the
 *   "snapshot then stream" pattern so the subscription is established before the snapshot is read.
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
  initialPayload?: InitialPayload<TEventData>
  eventIsFinal?: (event: TEventData) => boolean
}): AsyncIterator<TEventData> & AsyncIterable<TEventData> {
  let done = false

  const toQueue = (payload: TEventData | TEventData[] | undefined): TEventData[] =>
    payload === undefined ? [] : Array.isArray(payload) ? [...payload] : [payload]

  // Factory form: the caller wants the channel subscription established BEFORE the initial payload
  // (typically a DB snapshot) is read. The wrapped iterator subscribes on its first `next()`, so pull it
  // eagerly *now*. The resulting event is buffered and delivered after the initial payload drains; the
  // factory (and therefore the snapshot read) runs lazily on the first consumer `next()`, after the
  // subscription is already kicked.
  const isFactory = typeof initialPayload === 'function'
  let eagerPull: Promise<IteratorResult<TEventData>> | undefined = isFactory ? wrapped.next() : undefined

  // Value form: build the queue eagerly, exactly as before. Factory form: resolved lazily on first next().
  let initialQueue: TEventData[] | undefined = isFactory ? undefined : toQueue(initialPayload as TEventData | TEventData[] | undefined)

  // Hand back the eagerly-pulled (= already-subscribed) event the first time, then defer to wrapped.next().
  const consumeWrapped = (): Promise<IteratorResult<TEventData>> => {
    if (eagerPull) {
      const pull = eagerPull
      eagerPull = undefined
      return pull
    }
    return wrapped.next()
  }

  // Abandon the eager pull without leaking an unhandled rejection. Only reached via early teardown
  // (return/throw before the buffered event is consumed) or the eventIsFinal short-circuit on the
  // snapshot — neither consumes the buffered event, and wrapped.return() tears down the kicked subscription.
  const discardEagerPull = () => {
    if (eagerPull) {
      eagerPull.catch(() => {})
      eagerPull = undefined
    }
  }

  const iterator: AsyncIterator<TEventData> = {
    next: async () => {
      if (done) return { done: true, value: undefined }

      if (initialQueue === undefined) {
        initialQueue = toQueue(await (initialPayload as InitialPayloadFactory<TEventData>)())
      }

      if (initialQueue.length > 0) {
        const value = initialQueue.shift() as TEventData
        if (initialQueue.length === 0 && eventIsFinal && eventIsFinal(value)) {
          done = true
          discardEagerPull() // tear down the redundant eager subscription, if any
          await wrapped.return?.()
        }
        return { done: false, value }
      }

      const next = await consumeWrapped()
      if (!next.done && eventIsFinal && eventIsFinal(next.value)) {
        done = true
        await wrapped.return?.()
      }
      return next
    },
    return: async (value) => {
      done = true
      if (initialQueue) initialQueue.length = 0
      discardEagerPull()
      if (wrapped.return) return wrapped.return(value)
      return { done: true, value: value as TEventData }
    },
    throw: async (err) => {
      done = true
      if (initialQueue) initialQueue.length = 0
      discardEagerPull()
      if (wrapped.throw) return wrapped.throw(err)
      throw err
    },
  }

  return { ...iterator, [Symbol.asyncIterator]: () => iterator }
}
