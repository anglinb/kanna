/**
 * Device-code pairing, machine side: ask the control plane for a claim code,
 * hand the URL to whoever is looking at the UI (link + QR), and poll until a
 * signed-in browser claims it. The polling lives here — not in the browser —
 * so pairing completes even if the user finishes on their phone and the tab
 * that started it is long gone.
 *
 * Everything is DI'd (api client, clock, sleep) so the loop is testable
 * without network or real time.
 */

import { CloudApiError, createCloudApiClient, type CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"

export type PairSessionStatus = "idle" | "waiting" | "paired" | "expired" | "error"

/** The client-facing shape (served by `GET /api/cloud/pair-session`). */
export interface PairSessionSnapshot {
  status: PairSessionStatus
  /** Open this in any browser to finish pairing (also rendered as a QR). */
  claimUrl?: string
  /** Unix ms — the claim URL stops working after this. */
  expiresAt?: number
  /** Set once paired: this machine's public address. */
  appOrigin?: string
  error?: string
}

export interface PairSessionDeps {
  /** Display name suggested to the claim form (this machine's hostname). */
  machineName: string
  /** Persist credentials + bring the machine online. Failures surface as "error". */
  onPaired: (identity: CloudIdentity) => Promise<void> | void
  createApiClient?: () => CloudApiClient
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  warn?: (message: string) => void
}

export interface PairSessionManager {
  /** Idempotent: reuses the live session instead of burning codes on re-open. */
  start(): Promise<PairSessionSnapshot>
  status(): PairSessionSnapshot
  stop(): void
}

/** Transient control-plane failures tolerated before giving up on a session. */
const MAX_CONSECUTIVE_POLL_FAILURES = 10
const FALLBACK_POLL_INTERVAL_MS = 2_000

export function createPairSessionManager(deps: PairSessionDeps): PairSessionManager {
  const createApiClient = deps.createApiClient ?? (() => createCloudApiClient())
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let snapshot: PairSessionSnapshot = { status: "idle" }
  let stopped = false
  /** Bumped per session so a stale loop can tell it has been superseded. */
  let generation = 0

  function isLive(snapshotToCheck: PairSessionSnapshot) {
    return (
      snapshotToCheck.status === "waiting" &&
      typeof snapshotToCheck.expiresAt === "number" &&
      snapshotToCheck.expiresAt > now()
    )
  }

  async function poll(
    client: CloudApiClient,
    deviceToken: string,
    pollIntervalMs: number,
    expiresAt: number,
    session: number,
  ) {
    let failures = 0

    while (!stopped && session === generation) {
      await sleep(pollIntervalMs)
      if (stopped || session !== generation) return

      if (now() >= expiresAt) {
        snapshot = { status: "expired" }
        return
      }

      let result
      try {
        result = await client.pollDeviceCode(deviceToken)
        failures = 0
      } catch (error) {
        // The session is gone for good (expired server-side, or redeemed).
        if (error instanceof CloudApiError && (error.status === 404 || error.status === 410)) {
          snapshot = { status: "expired" }
          return
        }
        failures += 1
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          snapshot = {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          }
          return
        }
        continue
      }

      if (result.status !== "claimed" || !result.pairing) continue

      const pairing = result.pairing
      const identity: CloudIdentity = {
        controlUrl: client.controlUrl,
        machineToken: pairing.machineToken,
        proxySecret: pairing.proxySecret,
        subdomain: pairing.subdomain,
        appOrigin: pairing.appOrigin,
        tunnelToken: pairing.tunnelToken,
        tunnelHost: pairing.tunnelHost,
        enabled: true,
      }
      try {
        await deps.onPaired(identity)
      } catch (error) {
        snapshot = {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }
        deps.warn?.(`cloud: pairing succeeded but activation failed: ${snapshot.error}`)
        return
      }
      snapshot = { status: "paired", appOrigin: pairing.appOrigin }
      deps.log?.(`cloud: paired! this machine is now ${pairing.appOrigin}`)
      return
    }
  }

  return {
    status: () => snapshot,

    async start() {
      if (snapshot.status === "paired" || isLive(snapshot)) {
        return snapshot
      }

      stopped = false
      const session = ++generation
      const client = createApiClient()
      let issued
      try {
        issued = await client.requestDeviceCode(deps.machineName)
      } catch (error) {
        snapshot = {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        }
        return snapshot
      }
      if (session !== generation) return snapshot

      snapshot = {
        status: "waiting",
        claimUrl: issued.claimUrl,
        expiresAt: issued.expiresAt,
      }
      void poll(
        client,
        issued.deviceToken,
        issued.pollIntervalMs > 0 ? issued.pollIntervalMs : FALLBACK_POLL_INTERVAL_MS,
        issued.expiresAt,
        session,
      )
      return snapshot
    },

    stop() {
      stopped = true
      generation += 1
    },
  }
}
