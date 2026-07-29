/**
 * Client half of device-code pairing (see server/cloud/pair-session.ts).
 *
 * The machine owns the polling — this is just "start a session" and "how's it
 * going", so closing the dialog (or the laptop lid on the browser tab) never
 * strands a claim finished on someone's phone.
 */

import { CLOUD_PAIR_SESSION_PATH } from "../../shared/cloud-api"

export type PairSessionStatus =
  | "idle"
  | "waiting"
  | "paired"
  | "expired"
  | "error"
  /** This build/run can't pair from the UI — fall back to the manual steps. */
  | "unsupported"

export interface PairSessionState {
  status: PairSessionStatus
  claimUrl?: string
  expiresAt?: number
  appOrigin?: string
  error?: string
}

async function request(method: "GET" | "POST", fetchImpl: typeof fetch): Promise<PairSessionState> {
  try {
    const response = await fetchImpl(CLOUD_PAIR_SESSION_PATH, {
      method,
      headers: { Accept: "application/json" },
    })
    if (!response.ok) {
      return { status: "unsupported" }
    }
    const payload = await response.json() as PairSessionState
    return payload?.status ? payload : { status: "unsupported" }
  } catch {
    return { status: "unsupported" }
  }
}

/** Non-mutating: reports the current session without minting a code. */
export function fetchPairSession(fetchImpl: typeof fetch = fetch) {
  return request("GET", fetchImpl)
}

/** Mints a claim URL, or returns the live one if a session is already open. */
export function startPairSession(fetchImpl: typeof fetch = fetch) {
  return request("POST", fetchImpl)
}

/** "https://kanna.sh/machine?pair=ABC" → "kanna.sh/machine?pair=ABC" */
export function displayClaimUrl(claimUrl: string) {
  return claimUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
}
