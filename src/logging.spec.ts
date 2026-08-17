import type { Logger } from '@makerx/node-common'
import { describe, expect, it, vi } from 'vitest'
import type { DeprecatedElementUsage } from './deprecation'
import { logGraphQLOperation } from './logging'

const makeLogger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn() }) satisfies Logger

const loggedEntry = (logger: ReturnType<typeof makeLogger>): Record<string, unknown> =>
  logger.info.mock.calls[0]?.[1] as Record<string, unknown>

const usage: DeprecatedElementUsage = {
  kind: 'output-field',
  name: 'Widget.legacyName',
  deprecationReason: 'Use name.',
  path: 'widget.legacyName',
}

describe('logGraphQLOperation', () => {
  describe('deprecatedElements', () => {
    it('includes the elements when any were collected', () => {
      const logger = makeLogger()

      logGraphQLOperation({ logger, operationName: 'GetWidget', deprecatedElements: [usage] })

      expect(loggedEntry(logger).deprecatedElements).toEqual([usage])
    })

    it('omits the key entirely when the collection came back empty', () => {
      // `omitBy(..., isNil)` keeps an empty array, so every operation would otherwise carry a
      // `deprecatedElements: []` that means nothing.
      const logger = makeLogger()

      logGraphQLOperation({ logger, operationName: 'GetWidget', deprecatedElements: [] })

      expect(loggedEntry(logger)).not.toHaveProperty('deprecatedElements')
    })

    it('omits the key when collection was not requested', () => {
      const logger = makeLogger()

      logGraphQLOperation({ logger, operationName: 'GetWidget' })

      expect(loggedEntry(logger)).not.toHaveProperty('deprecatedElements')
    })
  })
})
