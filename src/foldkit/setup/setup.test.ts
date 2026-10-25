import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Scene } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { AuthServiceSnapshot, ProviderAuthSnapshot } from "../../shared/types"
import { AppAction, batch } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as ProviderAuth from "../core/stores/providerAuth"
import { init, Message, type Model } from "./model"
import { observe, update } from "./update"
import { LeavingMount, view } from "./view"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
  key() { return null }
  get length() { return this.values.size }
}

type Status = AuthServiceSnapshot["authStatus"]

function service(id: AuthServiceSnapshot["service"], authStatus: Status): AuthServiceSnapshot {
  return {
    service: id,
    label: { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gh: "GitHub", openrouter: "OpenRouter", grok: "Grok Build", pi: "Pi" }[id] ?? id,
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

function snapshot(statuses: Partial<Record<"claude" | "codex" | "cursor" | "gh" | "openrouter", Status>>): ProviderAuthSnapshot {
  return {
    services: (["claude", "codex", "cursor", "gh", "openrouter"] as const).map((id) => service(id, statuses[id] ?? "signed_out")),
  }
}

function boot(): AppModel {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: "dark",
    initialAppSettings: null,
    stores: Stores.load(new MemoryStorage() as unknown as Storage),
  }
  return initApp(flags, Option.getOrThrow(fromString("http://localhost/"))).model
}

function withAuth(app: AppModel, auth: Partial<ProviderAuth.Model>): AppModel {
  return { ...app, stores: { ...app.stores, providerAuth: { ...app.stores.providerAuth, ...auth } } }
}

const requested = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })
const providerAuth = (message: ProviderAuth.Message) => AppAction.Store({ message: Stores.Message.GotProviderAuthMessage({ message }) })

/** The wizard as the root would have it after the store opened it. */
function opened(auth: Partial<ProviderAuth.Model>, model: Model = init()) {
  const app = withAuth(boot(), { setupLoaded: true, setupShown: true, setupWizardOpen: true, ...auth })
  return { app, model: observe(model, app, app).model }
}

describe("setup: the launch rule (App.tsx)", () => {
  test("waits for the machine's flags, then opens a first launch at once", () => {
    const app = boot()
    const waiting = observe(init(), app, app)
    expect(waiting.outMessage).toBeUndefined()
    expect(waiting.model.launchDecided).toBe(false)

    const loaded = withAuth(app, { setupLoaded: true })
    const decided = observe(waiting.model, app, loaded)
    expect(decided.outMessage).toEqual(requested(providerAuth(ProviderAuth.Message.OpenedSetupWizard())))
    expect(decided.model.launchDecided).toBe(true)
    // The wizard's effects ran as if open: nothing is known yet, so GitHub first.
    expect(decided.model.wasOpen).toBe(true)
    expect(decided.model.step).toBe("github")
  })

  test("decides once per load: a later change never opens it again", () => {
    const app = withAuth(boot(), { setupLoaded: true, setupDismissed: true })
    const decided = observe(init(), app, app)
    expect(decided.outMessage).toBeUndefined()
    expect(decided.model.launchDecided).toBe(true)
    const later = withAuth(app, { setupDismissed: false, setupShown: false })
    expect(observe(decided.model, app, later).outMessage).toBeUndefined()
  })

  test("a returning machine waits for the probe round, and opens only with something missing", () => {
    const app = withAuth(boot(), { setupLoaded: true, setupShown: true })
    expect(observe(init(), app, app).model.launchDecided).toBe(false)
    const allIn = withAuth(app, { snapshot: snapshot({ claude: "signed_in", codex: "signed_in", cursor: "signed_in", gh: "signed_in", openrouter: "signed_in" }) })
    const none = observe(init(), app, allIn)
    expect(none.model.launchDecided).toBe(true)
    expect(none.outMessage).toBeUndefined()
  })
})

describe("setup: the steps", () => {
  test("opens at the first step not yet done", () => {
    expect(opened({ snapshot: snapshot({ gh: "signed_in" }) }).model.step).toBe("agents")
    expect(opened({ snapshot: snapshot({ gh: "signed_in", claude: "signed_in" }) }).model.step).toBe("openrouter")
    expect(opened({ snapshot: snapshot({ gh: "signed_in", claude: "signed_in", openrouter: "signed_in" }) }).model.step).toBe("done")
  })

  test("GitHub already connected on open drops its step from the bar", () => {
    const { model, app } = opened({ snapshot: snapshot({ gh: "signed_in" }) })
    expect(model.githubStepEnabled).toBe(false)
    // Back from the agents step has nowhere to go.
    expect(update(model, Message.ClickedBack(), app).model.step).toBe("agents")
  })

  test("skip, back and continue push the steps sideways", () => {
    const { model, app } = opened({ snapshot: snapshot({ claude: "signed_in", openrouter: "signed_in" }) })
    expect(model.step).toBe("github")
    const skipped = update(model, Message.ClickedSkip(), app).model
    expect(skipped).toMatchObject({ step: "agents", enterDirection: "forward", leaving: { from: "github", direction: "forward" } })
    const back = update(skipped, Message.ClickedBack(), app).model
    expect(back).toMatchObject({ step: "github", enterDirection: "back", leaving: { from: "agents", direction: "back" } })
    const ended = update(back, Message.EndedLeaving({ id: back.leaving!.id }), app).model
    expect(ended.leaving).toBeNull()
    // A stale end (an earlier leaving step's) changes nothing.
    expect(update(back, Message.EndedLeaving({ id: 1 }), app).model.leaving).not.toBeNull()

    const toEnd = update(update(update(back, Message.ClickedSkip(), app).model, Message.ClickedContinue(), app).model, Message.ClickedContinue(), app).model
    expect(toEnd).toMatchObject({ step: "done", enterDirection: "finish" })
  })

  test("a step that connects moves on after a beat, but not one returned to", () => {
    const start = opened({ snapshot: snapshot({ gh: "signed_out" }) })
    expect(start.model.step).toBe("github")
    const connectedApp = withAuth(start.app, { snapshot: snapshot({ gh: "signed_in" }) })
    const connected = observe(start.model, start.app, connectedApp)
    expect(connected.commands?.map((command) => command.name)).toEqual(["WaitSetupAutoAdvance"])
    const version = connected.model.advanceVersion
    const advanced = update(connected.model, Message.ElapsedAutoAdvance({ version, to: "agents" }), connectedApp).model
    expect(advanced.step).toBe("agents")
    // A timer cleared by a change in between does nothing.
    expect(update(connected.model, Message.ElapsedAutoAdvance({ version: version - 1, to: "agents" }), connectedApp).model.step).toBe("github")
    // Going back to GitHub, already connected, stays there.
    const backAgain = observe(update(advanced, Message.ClickedBack(), connectedApp).model, connectedApp, connectedApp)
    expect(backAgain.model.step).toBe("github")
    expect(backAgain.commands ?? []).toEqual([])
  })

  test("Set up later and Start Building ask the store (and Start Building goes home)", () => {
    const { model, app } = opened({ snapshot: snapshot({}) })
    expect(update(model, Message.ClickedSetUpLater(), app).outMessage).toEqual(requested(providerAuth(ProviderAuth.Message.DismissedSetupWizard())))
    expect(update(model, Message.ClickedStartBuilding(), app).outMessage).toEqual(requested(batch(
      providerAuth(ProviderAuth.Message.CompletedSetupWizard()),
      AppAction.Navigate({ path: "/", replace: false }),
    )))
  })

  test("the Mac app's Setup… opens it, remembering a request for the cloud step", () => {
    const result = update(init(), Message.RequestedOpen({ step: "cloud" }), boot())
    expect(result.model.requestedStep).toBe("cloud")
    expect(result.outMessage).toEqual(requested(providerAuth(ProviderAuth.Message.OpenedSetupWizard())))
  })
})

describe("setup: the wizard (Scene)", () => {
  const sceneFor = (app: AppModel) => ({
    update: (model: Model, message: Message) => {
      const result = update(model, message, app)
      return { model: result.model, commands: result.commands ?? [] }
    },
    view: Scene.withViewInputs(view, { app })(),
  })

  test("the GitHub step, skipped to the agents", () => {
    const { model, app } = opened({ snapshot: snapshot({ claude: "signed_in" }) })
    Scene.scene(
      sceneFor(app),
      Scene.given(model),
      Scene.expect(Scene.role("heading", { name: "Connect GitHub", level: 1 })).toExist(),
      Scene.expect(Scene.role("button", { name: "Continue" })).toBeDisabled(),
      Scene.expect(Scene.role("button", { name: "Log In" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Back" })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Skip for now" })),
      // The GitHub step leaves, inert, while the agents arrive.
      Scene.expectAll(Scene.all.role("heading", { name: "Connect GitHub", level: 1 })).toHaveCount(1),
      Scene.Mount.resolve(LeavingMount, Message.EndedLeaving({ id: 1 })),
      Scene.Mount.expectEnded(LeavingMount),
      Scene.expect(Scene.role("heading", { name: "Connect GitHub", level: 1 })).toBeAbsent(),
      Scene.expect(Scene.role("heading", { name: "Connect your agents", level: 1 })).toExist(),
      Scene.expect(Scene.role("button", { name: "Back" })).toExist(),
    )
  })

  test("the agents step: Continue once one is signed in", () => {
    const { model, app } = opened({ snapshot: snapshot({ claude: "signed_in", gh: "signed_in" }) })
    Scene.scene(
      sceneFor(app),
      Scene.given({ ...model, step: "agents" }),
      Scene.expect(Scene.role("button", { name: "Continue" })).toBeEnabled(),
      Scene.expectAll(Scene.all.role("button", { name: "Log In" })).toHaveCount(2),
      Scene.expect(Scene.role("button", { name: "Skip for now" })).toBeAbsent(),
    )
  })

  test("the last step sums up, and Start Building finishes", () => {
    const { model, app } = opened({ snapshot: snapshot({ gh: "signed_in", claude: "signed_in", openrouter: "signed_in" }) })
    Scene.scene(
      sceneFor(app),
      Scene.given(model),
      Scene.expect(Scene.role("heading", { name: "You're all set", level: 1 })).toExist(),
      Scene.expect(Scene.text("Skipped")).toExist(),
      Scene.expect(Scene.role("button", { name: "Continue" })).toBeAbsent(),
      Scene.click(Scene.role("button", { name: "Start Building" })),
    )
  })
})
