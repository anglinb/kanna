/**
 * Automatic retry for turns that died on a network blip between the harness
 * and its model API.
 *
 * Claude Code retries a failed request a few times on its own, and when those
 * run out it ends the turn with an error result whose text is the error, e.g.
 * `API Error: Unable to connect to API (EPROTO)` or
 * `API Error: Connection dropped (ECONNRESET)`. Nothing is wrong with the work
 * at that point: the session holds everything the turn did, so a "carry on"
 * once the network is back picks it up. These helpers decide which errors
 * qualify and how long to wait before each attempt.
 */

/** Socket and DNS error codes that say the connection failed, not the request. */
const TRANSIENT_ERROR_CODES = [
  "EPROTO",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EAI_AGAIN",
] as const

const TRANSIENT_CODE_PATTERN = new RegExp(`\\((?:${TRANSIENT_ERROR_CODES.join("|")})\\)`)

/** Attempts after the first failure before the chat is left failed. */
export const TRANSIENT_RETRY_MAX_ATTEMPTS = 6
const TRANSIENT_RETRY_BASE_MS = 2_000
const TRANSIENT_RETRY_MAX_DELAY_MS = 60_000

/**
 * Whether a turn's error text is a connection failure worth retrying.
 *
 * Only the harness's own API error line counts: a tool whose output happens
 * to mention ECONNRESET is the model's problem to handle, not a dead turn.
 */
export function isTransientApiError(text: string | null | undefined): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (!trimmed.startsWith("API Error:")) return false
  return TRANSIENT_CODE_PATTERN.test(trimmed)
    || /^API Error: (?:Unable to connect to API|Connection (?:dropped|error|closed)|Request timed out)/i.test(trimmed)
}

/**
 * Delay before retry number `attempt` (1-based): 2s, 4s, 8s, ... capped at a
 * minute, with up to 20% jitter so several chats that failed together do not
 * all come back in the same instant.
 */
export function transientRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1)
  const base = Math.min(TRANSIENT_RETRY_MAX_DELAY_MS, TRANSIENT_RETRY_BASE_MS * 2 ** exponent)
  return Math.round(base * (1 + 0.2 * random()))
}

export function formatRetryStatus(attempt: number, delayMs: number): string {
  const seconds = Math.max(1, Math.round(delayMs / 1000))
  return `Connection to the API failed. Retrying in ${seconds}s (attempt ${attempt} of ${TRANSIENT_RETRY_MAX_ATTEMPTS})…`
}
