import { describe, expect, test } from "bun:test"
import type { AuthServiceSnapshot, ProviderAuthSnapshot } from "../../shared/types"
import { getSetupLaunchAction } from "./providerAuthStore"

function service(
  id: AuthServiceSnapshot["service"],
  authStatus: AuthServiceSnapshot["authStatus"],
): AuthServiceSnapshot {
  return {
    service: id,
    label: id,
    installed: authStatus !== "not_installed",
    version: null,
    latestVersion: null,
    authStatus,
    account: null,
    statusDetail: null,
    checkedAt: 1,
    installState: "idle",
    installError: null,
    login: { phase: "idle" },
  }
}

function snapshotWith(status: AuthServiceSnapshot["authStatus"]): ProviderAuthSnapshot {
  return {
    services: (["claude", "codex", "cursor", "gh", "openrouter"] as const).map((id) =>
      service(id, status),
    ),
  }
}

const FLAGS = { setupShown: false, setupCompleted: false, setupDismissed: false }

describe("getSetupLaunchAction", () => {
  test("first-ever launch opens instantly, before any probe resolves", () => {
    expect(getSetupLaunchAction(null, FLAGS)).toBe("open")
    expect(getSetupLaunchAction(snapshotWith("unknown"), FLAGS)).toBe("open")
  })

  test("completed or dismissed setups never auto-launch", () => {
    expect(getSetupLaunchAction(null, { ...FLAGS, setupCompleted: true })).toBe("none")
    expect(getSetupLaunchAction(null, { ...FLAGS, setupDismissed: true })).toBe("none")
  })

  test("after a first showing, launches wait for the probe round", () => {
    const shown = { ...FLAGS, setupShown: true }
    expect(getSetupLaunchAction(null, shown)).toBe("wait")
    expect(getSetupLaunchAction(snapshotWith("unknown"), shown)).toBe("wait")
    // Resolved with something missing → re-open; fully connected → stay quiet.
    expect(getSetupLaunchAction(snapshotWith("signed_out"), shown)).toBe("open")
    expect(getSetupLaunchAction(snapshotWith("signed_in"), shown)).toBe("none")
  })
})
