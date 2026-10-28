import { describe, expect, test } from "bun:test"
import {
  formatRetryStatus,
  isTransientApiError,
  TRANSIENT_RETRY_MAX_ATTEMPTS,
  transientRetryDelayMs,
} from "./transient-api-error"

describe("isTransientApiError", () => {
  test("matches the connection failures Claude Code reports", () => {
    expect(isTransientApiError("API Error: Unable to connect to API (EPROTO)")).toBe(true)
    expect(isTransientApiError("API Error: Connection dropped (ECONNRESET)")).toBe(true)
    expect(isTransientApiError("API Error: Unable to connect to API (ENOTFOUND)")).toBe(true)
    expect(isTransientApiError("API Error: Unable to connect to API")).toBe(true)
  })

  test("leaves other errors alone", () => {
    expect(isTransientApiError("API Error: Opus's safeguards flagged this message.")).toBe(false)
    expect(isTransientApiError("API Error: 401 invalid x-api-key")).toBe(false)
    expect(isTransientApiError("curl failed (ECONNRESET)")).toBe(false)
    expect(isTransientApiError("")).toBe(false)
    expect(isTransientApiError(undefined)).toBe(false)
  })
})

describe("transientRetryDelayMs", () => {
  test("doubles from 2s and caps at a minute", () => {
    const noJitter = () => 0
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => transientRetryDelayMs(attempt, noJitter)))
      .toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
  })

  test("adds at most 20% jitter", () => {
    expect(transientRetryDelayMs(1, () => 1)).toBe(2_400)
  })
})

test("formatRetryStatus names the attempt and the wait", () => {
  expect(formatRetryStatus(2, 4_000)).toBe(
    `Connection to the API failed. Retrying in 4s (attempt 2 of ${TRANSIENT_RETRY_MAX_ATTEMPTS})…`,
  )
})
