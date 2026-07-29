import { describe, expect, test } from "bun:test"
import type { CloudDeviceCodePollResponse } from "../../shared/cloud-api"
import { CloudApiError, type CloudApiClient } from "./api-client"
import type { CloudIdentity } from "./identity"
import { createPairSessionManager, type PairSessionManager } from "./pair-session"

const NOW = 1_700_000_000_000
const CONTROL_URL = "https://kanna.sh/api/cloud"

const PAIRING = {
  machineToken: "machine-token",
  proxySecret: "proxy-secret",
  subdomain: "jakemor-mbp",
  appOrigin: "https://jakemor-mbp.kanna.sh",
  tunnelToken: "connector-token",
  tunnelHost: "tun-m1.kanna.sh",
}

interface FakeApiOptions {
  /** Consumed one per poll; the last entry repeats. */
  polls?: Array<CloudDeviceCodePollResponse | Error>
  requestError?: Error
  expiresAt?: number
}

function createFakeApi(options: FakeApiOptions = {}) {
  const calls = { requests: 0, polls: 0 }
  const polls = options.polls ?? [{ status: "pending" as const }]

  const client: CloudApiClient = {
    controlUrl: CONTROL_URL,
    async pair() {
      throw new Error("not used")
    },
    async requestDeviceCode() {
      calls.requests += 1
      if (options.requestError) throw options.requestError
      return {
        code: "ABC123",
        deviceToken: "device-token",
        claimUrl: "https://kanna.sh/machine?pair=ABC123",
        expiresAt: options.expiresAt ?? NOW + 900_000,
        pollIntervalMs: 1,
      }
    },
    async pollDeviceCode() {
      const next = polls[Math.min(calls.polls, polls.length - 1)]
      calls.polls += 1
      if (next instanceof Error) throw next
      return next
    },
    async heartbeat() {},
    async markOffline() {},
    async removeMachine() {},
  }

  return { client, calls }
}

/** Real macrotask so the manager's loop and the test can interleave. */
const yieldTick = () => Bun.sleep(0)

async function waitForSettled(manager: PairSessionManager, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (manager.status().status === "waiting") {
    if (Date.now() > deadline) throw new Error("pair session never settled")
    await yieldTick()
  }
  return manager.status()
}

function createManager(
  api: ReturnType<typeof createFakeApi>,
  overrides: {
    onPaired?: (identity: CloudIdentity) => Promise<void> | void
    now?: () => number
  } = {},
) {
  const paired: CloudIdentity[] = []
  const manager = createPairSessionManager({
    machineName: "Jake's MBP",
    createApiClient: () => api.client,
    now: overrides.now ?? (() => NOW),
    sleep: yieldTick,
    onPaired: overrides.onPaired ?? ((identity) => {
      paired.push(identity)
    }),
  })
  return { manager, paired }
}

describe("createPairSessionManager", () => {
  test("start() issues a claim URL and reports waiting", async () => {
    const api = createFakeApi()
    const { manager } = createManager(api)

    const snapshot = await manager.start()
    manager.stop()

    expect(snapshot.status).toBe("waiting")
    expect(snapshot.claimUrl).toBe("https://kanna.sh/machine?pair=ABC123")
    expect(snapshot.expiresAt).toBe(NOW + 900_000)
    expect(api.calls.requests).toBe(1)
  })

  test("start() reuses a live session instead of burning a second code", async () => {
    const api = createFakeApi()
    const { manager } = createManager(api)

    const first = await manager.start()
    const second = await manager.start()
    manager.stop()

    expect(second).toEqual(first)
    expect(api.calls.requests).toBe(1)
  })

  test("a claim hands credentials to onPaired and flips to paired", async () => {
    const api = createFakeApi({
      polls: [{ status: "pending" }, { status: "claimed", pairing: PAIRING }],
    })
    const { manager, paired } = createManager(api)

    await manager.start()
    const settled = await waitForSettled(manager)

    expect(settled.status).toBe("paired")
    expect(settled.appOrigin).toBe(PAIRING.appOrigin)
    expect(paired).toEqual([
      {
        controlUrl: CONTROL_URL,
        machineToken: PAIRING.machineToken,
        proxySecret: PAIRING.proxySecret,
        subdomain: PAIRING.subdomain,
        appOrigin: PAIRING.appOrigin,
        tunnelToken: PAIRING.tunnelToken,
        tunnelHost: PAIRING.tunnelHost,
        enabled: true,
      },
    ])
  })

  test("start() after pairing keeps the paired snapshot", async () => {
    const api = createFakeApi({ polls: [{ status: "claimed", pairing: PAIRING }] })
    const { manager } = createManager(api)

    await manager.start()
    await waitForSettled(manager)
    const again = await manager.start()

    expect(again.status).toBe("paired")
    expect(api.calls.requests).toBe(1)
  })

  test("a redeemed or unknown session expires instead of polling forever", async () => {
    const api = createFakeApi({ polls: [new CloudApiError("gone", 410)] })
    const { manager } = createManager(api)

    await manager.start()
    const settled = await waitForSettled(manager)

    expect(settled.status).toBe("expired")
  })

  test("transient poll failures are retried, not fatal", async () => {
    const api = createFakeApi({
      polls: [new Error("network"), new Error("network"), { status: "claimed", pairing: PAIRING }],
    })
    const { manager, paired } = createManager(api)

    await manager.start()
    const settled = await waitForSettled(manager)

    expect(settled.status).toBe("paired")
    expect(paired).toHaveLength(1)
  })

  test("a repeatedly failing control plane surfaces an error", async () => {
    const api = createFakeApi({ polls: [new Error("network unreachable")] })
    const { manager } = createManager(api)

    await manager.start()
    const settled = await waitForSettled(manager)

    expect(settled.status).toBe("error")
    expect(settled.error).toContain("network unreachable")
  })

  test("the local clock passing expiry ends the session", async () => {
    const api = createFakeApi({ expiresAt: NOW + 1_000 })
    let clock = NOW
    const { manager } = createManager(api, { now: () => clock })

    await manager.start()
    clock = NOW + 2_000
    const settled = await waitForSettled(manager)

    expect(settled.status).toBe("expired")
  })

  test("failing to activate the pairing surfaces as an error, not silent success", async () => {
    const api = createFakeApi({ polls: [{ status: "claimed", pairing: PAIRING }] })
    const { manager } = createManager(api, {
      onPaired: () => {
        throw new Error("cloud.json is read-only")
      },
    })

    await manager.start()
    const settled = await waitForSettled(manager)

    expect(settled.status).toBe("error")
    expect(settled.error).toContain("read-only")
  })

  test("start() reports a control-plane failure without wedging the manager", async () => {
    const api = createFakeApi({ requestError: new Error("503") })
    const { manager } = createManager(api)

    const snapshot = await manager.start()

    expect(snapshot.status).toBe("error")
    expect(snapshot.error).toContain("503")
  })

  test("stop() halts polling", async () => {
    const api = createFakeApi()
    const { manager } = createManager(api)

    await manager.start()
    await yieldTick()
    manager.stop()
    const after = api.calls.polls
    await yieldTick()
    await yieldTick()

    expect(api.calls.polls).toBe(after)
  })
})
