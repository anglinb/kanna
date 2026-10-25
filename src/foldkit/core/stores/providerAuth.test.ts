import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import type { AuthServiceSnapshot, ProviderAuthSnapshot } from "../../../shared/types"
import {
  getSetupLaunchAction,
  initialModel,
  Message,
  PersistSetupFlags,
  showSetupCard,
  unauthenticatedHarnesses,
  update,
} from "./providerAuth"
import { run } from "./testing"

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
    updateAvailable: false,
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

const FLAGS = {
  setupLoaded: true,
  setupShown: false,
  setupCompleted: false,
  setupDismissed: false,
}

describe("getSetupLaunchAction", () => {
  test("waits for the machine's settings before deciding anything", () => {
    // A fresh browser starts with every flag false; acting on that would
    // re-run onboarding per browser instead of per machine.
    const unloaded = { ...FLAGS, setupLoaded: false }
    expect(getSetupLaunchAction(null, unloaded)).toBe("wait")
    expect(getSetupLaunchAction(snapshotWith("signed_in"), unloaded)).toBe("wait")
    expect(getSetupLaunchAction(snapshotWith("signed_out"), unloaded)).toBe("wait")
  })

  test("a machine that finished setup never re-onboards a new browser", () => {
    const completed = { ...FLAGS, setupShown: true, setupCompleted: true }
    expect(getSetupLaunchAction(null, completed)).toBe("none")
    // Even with services since signed out, a completed machine stays quiet.
    expect(getSetupLaunchAction(snapshotWith("signed_out"), completed)).toBe("none")
  })

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

describe("provider auth", () => {
  test("opening the wizard marks it shown on the machine", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.OpenedSetupWizard()),
      Story.Command.expectExact(PersistSetupFlags({ patch: { setupShown: true } })),
      Story.Command.resolve(PersistSetupFlags, Message.CompletedPersistSetupFlags()),
      Story.model((model) => {
        expect(model.setupWizardOpen).toBe(true)
        expect(model.setupShown).toBe(true)
      }),
    )
  })

  test("dismissing and completing persist their own markers", () => {
    Story.story(
      update,
      Story.given({ ...initialModel, setupWizardOpen: true }),
      Story.message(Message.DismissedSetupWizard()),
      Story.Command.expectExact(PersistSetupFlags({ patch: { setupDismissed: true } })),
      Story.Command.resolve(PersistSetupFlags, Message.CompletedPersistSetupFlags()),
      Story.model((model) => expect(model).toMatchObject({ setupWizardOpen: false, setupDismissed: true })),
      Story.message(Message.CompletedSetupWizard()),
      Story.Command.expectExact(PersistSetupFlags({ patch: { setupCompleted: true, setupDismissed: true } })),
      Story.Command.resolve(PersistSetupFlags, Message.CompletedPersistSetupFlags()),
      Story.model((model) => expect(model).toMatchObject({ setupWizardOpen: false, setupCompleted: true })),
    )
  })

  test("the machine's flags never un-set one this browser just set", () => {
    const opened = run(update, initialModel, Message.OpenedSetupWizard())
    const synced = run(update, opened, Message.ReceivedSetupFlags({ setupShown: false, setupCompleted: false, setupDismissed: true }))
    expect(synced).toMatchObject({ setupLoaded: true, setupShown: true, setupCompleted: false, setupDismissed: true })
  })

  test("the setup card waits for the machine's flags and the probe round", () => {
    const withSnapshot = run(update, initialModel, Message.ReceivedProviderAuthSnapshot({ snapshot: snapshotWith("signed_out") }))
    expect(showSetupCard(withSnapshot)).toBe(false)
    const loaded = run(update, withSnapshot, Message.ReceivedSetupFlags({ setupShown: true, setupCompleted: false, setupDismissed: false }))
    expect(showSetupCard(loaded)).toBe(true)
    expect(showSetupCard(run(update, loaded, Message.ReceivedSetupFlags({ setupShown: true, setupCompleted: true, setupDismissed: true })))).toBe(false)
  })

  test("signed-out harnesses gate, and the answer holds its identity per snapshot", () => {
    const model = run(update, initialModel, Message.ReceivedProviderAuthSnapshot({ snapshot: snapshotWith("signed_out") }))
    const harnesses = unauthenticatedHarnesses(model)
    expect([...harnesses].sort()).toEqual(["claude", "codex", "cursor"])
    expect(unauthenticatedHarnesses(model)).toBe(harnesses)
    expect(unauthenticatedHarnesses(initialModel).size).toBe(0)
  })
})
