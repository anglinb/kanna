import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { AppAction, batch } from "../app/action"
import { SliceOutMessage, type AppModel, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import type { KannaSocketService } from "../core/socket"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as AuthCard from "../settings/auth-cards"
import * as CloudPair from "../settings/cloud-pair"
import { macSetup } from "../settings/macApp"
import { BASE_STEPS, Message, SetupStep, type EffectInputs, type Model } from "./model"
import { macSetupSatisfied } from "./rows"

// The wizard's flow (components/auth/SetupWizard.tsx) and the launch rule
// from App.tsx. React moved the wizard on in effects; `observe` runs the
// same effects, in the same order, whenever the root changes (see
// `runEffects`).

/** Auto-advance delay after a skippable step connects: long enough to see the ✓ land. */
export const AUTO_ADVANCE_MS = 900

type Return = SliceReturn<Model, Message>
type WizardCommand = Command.Command<Message, never, KannaSocketService>

const providerAuthAction = (message: ProviderAuth.Message) =>
  AppAction.Store({ message: Stores.Message.GotProviderAuthMessage({ message }) })

// COMMANDS

const WaitAutoAdvance = Command.define("WaitSetupAutoAdvance", {
  args: { version: Schema.Number, to: SetupStep, ms: Schema.Number },
  messages: [Message.ElapsedAutoAdvance],
  execute: ({ version, to, ms }) => Effect.sleep(Duration.millis(ms)).pipe(Effect.as(Message.ElapsedAutoAdvance({ version, to }))),
})

const WaitPairedAdvance = Command.define("WaitSetupPairedAdvance", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedPairedAdvance],
  execute: ({ version }) => Effect.sleep(Duration.millis(AUTO_ADVANCE_MS * 2)).pipe(Effect.as(Message.ElapsedPairedAdvance({ version }))),
})

const MacRequest = Schema.Union([
  Schema.TaggedStruct("OpenLoginItems", {}),
  Schema.TaggedStruct("SetLoginItem", { enabled: Schema.Boolean }),
  Schema.TaggedStruct("SetKeepAwake", { onPower: Schema.optional(Schema.Boolean), onBattery: Schema.optional(Schema.Boolean) }),
  Schema.TaggedStruct("OpenFullDiskAccess", {}),
])

/** One request to Kanna for Mac; it answers with the new state (`kanna:mac-setup`). */
const PostMacRequest = Command.define("PostSetupMacRequest", {
  args: { request: MacRequest },
  messages: [Message.CompletedMacRequest],
  execute: ({ request }) => Effect.sync(() => {
    switch (request._tag) {
      case "OpenLoginItems": macSetup.openLoginItems(); break
      case "SetLoginItem": macSetup.setLoginItem(request.enabled); break
      case "SetKeepAwake": macSetup.setKeepAwake({
        ...(request.onPower !== undefined ? { onPower: request.onPower } : {}),
        ...(request.onBattery !== undefined ? { onBattery: request.onBattery } : {}),
      }); break
      case "OpenFullDiskAccess": macSetup.openFullDiskAccess(); break
    }
    return Message.CompletedMacRequest()
  }),
})

const liftCloud = (commands: ReadonlyArray<Command.Command<CloudPair.Message>> | undefined): WizardCommand[] =>
  [...Command.mapMessages(commands ?? [], (message: CloudPair.Message) => Message.GotCloudMessage({ message }))]

// DERIVED

export function cloudCapable(app: AppModel) {
  return app.stores.serverCapabilities.value?.cloud === true
}

/** The steps this run shows, in order. */
export function stepsOf(model: Model, app: AppModel): SetupStep[] {
  return [
    ...(model.macStepEnabled ? (["mac"] as const) : []),
    ...BASE_STEPS.filter((base) => base !== "github" || model.githubStepEnabled),
    ...(model.cloudStepEnabled && cloudCapable(app) ? (["cloud"] as const) : []),
    "done",
  ]
}

/** A CloudPairPanel mounted afresh shows the session as it is, without a swap. */
function freshPanel(cloud: CloudPair.Model): CloudPair.Model {
  return { ...cloud, shown: cloud.session, leaving: null, swapped: false, height: null }
}

/**
 * Steps push sideways: forward, the step leaves to the left as the next
 * arrives from the right; back is the exact reverse. The leaving step stays
 * on screen, inert, for its short exit (index.css .wizard-leave). A second
 * press mid-transition replaces it, so nothing ever waits. Both are fresh
 * mounts in React, so their cards start over.
 */
export function go(model: Model, next: SetupStep, app: AppModel): Model {
  if (next === model.step) return model
  const steps = stepsOf(model, app)
  const direction = steps.indexOf(next) >= steps.indexOf(model.step) ? "forward" : "back"
  const id = model.leaveCount + 1
  return {
    ...model,
    leaving: { from: model.step, direction, id },
    leaveCount: id,
    enterDirection: next === "done" && direction === "forward" ? "finish" : direction,
    step: next,
    cards: {},
    cloud: freshPanel(model.cloud),
  }
}

function goNext(model: Model, app: AppModel): Model {
  const steps = stepsOf(model, app)
  const index = steps.indexOf(model.step)
  return go(model, steps[Math.min(steps.length - 1, index + 1)]!, app)
}

function goBack(model: Model, app: AppModel): Model {
  const steps = stepsOf(model, app)
  const index = steps.indexOf(model.step)
  return go(model, steps[Math.max(0, index - 1)]!, app)
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    RequestedOpen: ({ step }) => ({
      model: { ...model, requestedStep: step },
      outMessage: SliceOutMessage.RequestedAppAction({ action: providerAuthAction(ProviderAuth.Message.OpenedSetupWizard()) }),
    }),
    // Low-emphasis escape hatch: suppresses auto-launch, keeps the Setup card.
    ClickedSetUpLater: () => ({
      model,
      outMessage: SliceOutMessage.RequestedAppAction({ action: providerAuthAction(ProviderAuth.Message.DismissedSetupWizard()) }),
    }),
    ClickedContinue: () => ({ model: goNext(model, app) }),
    ClickedSkip: () => ({ model: goNext(model, app) }),
    ClickedBack: () => ({ model: goBack(model, app) }),
    // Finishing onboarding always lands on the home page.
    ClickedStartBuilding: () => ({
      model,
      outMessage: SliceOutMessage.RequestedAppAction({
        action: batch(
          providerAuthAction(ProviderAuth.Message.CompletedSetupWizard()),
          AppAction.Navigate({ path: "/", replace: false }),
        ),
      }),
    }),
    EndedLeaving: ({ id }) => (model.leaving?.id === id ? { model: { ...model, leaving: null } } : { model }),
    ElapsedAutoAdvance: ({ version, to }) => (version === model.advanceVersion ? { model: go(model, to, app) } : { model }),
    ElapsedPairedAdvance: ({ version }) => (version === model.pairedAdvanceVersion ? { model: go(model, "done", app) } : { model }),
    ReceivedMacState: ({ state }) => ({ model: { ...model, macState: state } }),
    ClickedOpenLoginItems: () => ({ model, commands: [PostMacRequest({ request: { _tag: "OpenLoginItems" } })] }),
    ToggledLoginItem: ({ enabled }) => ({ model, commands: [PostMacRequest({ request: { _tag: "SetLoginItem", enabled } })] }),
    ToggledKeepAwake: ({ onPower }) => ({ model, commands: [PostMacRequest({ request: { _tag: "SetKeepAwake", onPower } })] }),
    ToggledKeepAwakeOnBattery: ({ onBattery }) => ({ model, commands: [PostMacRequest({ request: { _tag: "SetKeepAwake", onBattery } })] }),
    ClickedOpenFullDiskAccess: () => ({ model, commands: [PostMacRequest({ request: { _tag: "OpenFullDiskAccess" } })] }),
    CompletedMacRequest: () => ({ model }),
    GotAuthCardMessage: ({ id, message: child }) => {
      const result = AuthCard.update(model.cards[id] ?? AuthCard.init(id), child)
      return {
        model: { ...model, cards: { ...model.cards, [id]: result.model } },
        commands: Command.mapMessages(result.commands ?? [], (next: AuthCard.Message) => Message.GotAuthCardMessage({ id, message: next })),
      }
    },
    GotCloudMessage: ({ message: child }) => {
      // useCloudPairSession dropped its status fetch once it was disabled.
      if (child._tag === "ReceivedSession" && !model.effectInputs?.cloudEnabled) return { model }
      const result = CloudPair.update(model.cloud, child)
      return { model: { ...model, cloud: result.model }, commands: liftCloud(result.commands) }
    },
  })
}

// EFFECTS

function inputsOf(model: Model, app: AppModel, open: boolean): EffectInputs {
  const auth = app.stores.providerAuth
  const status = ProviderAuth.setupStatus(auth)
  const ghStatus = ProviderAuth.selectAuthService(auth.snapshot, "gh")?.authStatus
  return {
    open,
    cloudEnabled: open && cloudCapable(app),
    cloudLoaded: model.cloud.loaded,
    cloudStatus: model.cloud.session.status,
    ghKnown: ghStatus !== undefined && ghStatus !== "unknown",
    githubConnected: status.githubConnected,
    openRouterConnected: status.openRouterConnected,
    machinePaired: model.cloud.session.status === "paired",
    step: model.step,
    cloudStepEnabled: model.cloudStepEnabled,
  }
}

function sameInputs(a: EffectInputs | null, b: EffectInputs) {
  if (!a) return false
  return (Object.keys(b) as Array<keyof EffectInputs>).every((key) => a[key] === b[key])
}

/**
 * One commit's effects, in the order SetupWizard declared them. `render` is
 * the state that commit rendered (what an effect reads of useState); refs
 * change at once, so later effects in the same commit see them; state set
 * here shows on the next pass, as a re-render would.
 */
function runEffects(render: Model, previous: EffectInputs | null, current: EffectInputs, app: AppModel): { model: Model; commands: WizardCommand[] } {
  let model = render
  const commands: WizardCommand[] = []
  const changed = (...keys: Array<keyof EffectInputs>) => previous === null || keys.some((key) => previous[key] !== current[key])
  const auth = app.stores.providerAuth
  const status = ProviderAuth.setupStatus(auth)

  // useCloudPairSession: the current state, without minting a code, each time it's enabled.
  if (changed("cloudEnabled") && current.cloudEnabled) {
    commands.push(...liftCloud(CloudPair.load(model.cloud).commands))
  }

  // Decided once per open, from the first status that lands.
  if (changed("open", "cloudLoaded", "cloudStatus")) {
    if (!current.open) {
      model = { ...model, cloudDecided: false, cloudStarted: false }
    } else if (!model.cloudDecided && current.cloudLoaded) {
      const enabled = current.cloudStatus !== "paired" && current.cloudStatus !== "unsupported"
      model = {
        ...model,
        cloudDecided: true,
        cloudStepEnabled: enabled,
        ...(enabled && model.requestedStep === "cloud" ? { step: "cloud" as const } : {}),
        requestedStep: null,
      }
    }
  }

  // On open, start at the first unsatisfied step (all satisfied → done).
  if (changed("open")) {
    if (current.open && !model.wasOpen) {
      model = {
        ...model,
        leaving: null,
        enterDirection: "open",
        githubDecided: current.ghKnown,
        githubStepEnabled: !current.ghKnown || !status.githubConnected,
        step: render.macStepEnabled && !macSetupSatisfied(render.macState) ? "mac"
          : !status.githubConnected ? "github"
          : !status.anyAgentConnected ? "agents"
          : !status.openRouterConnected ? "openrouter"
          : "done",
        // The wizard's content mounts afresh on each open.
        cards: {},
        cloud: freshPanel(model.cloud),
      }
    }
    model = { ...model, wasOpen: current.open }
  }

  if (changed("open", "ghKnown", "githubConnected", "step")) {
    if (!current.open) {
      model = { ...model, githubDecided: false }
    } else if (!model.githubDecided && current.ghKnown) {
      model = { ...model, githubDecided: true }
      if (current.githubConnected && render.step !== "github") model = { ...model, githubStepEnabled: false }
    }
  }

  // Entering the cloud step mints the claim URL (once: the server hands back
  // the live session if one is already open).
  if (changed("step", "cloudStatus", "cloudEnabled")) {
    if (render.step === "cloud" && !model.cloudStarted && current.cloudStatus !== "paired") {
      model = { ...model, cloudStarted: true }
      if (current.cloudEnabled) {
        const begun = CloudPair.begin(model.cloud)
        model = { ...model, cloud: begun.model }
        commands.push(...liftCloud(begun.commands))
      }
    }
  }

  // Auto-advance skippable steps on the false→true connect transition only,
  // so navigating Back to an already-connected step doesn't bounce forward.
  if (changed("open", "step", "githubConnected", "openRouterConnected", "cloudStepEnabled")) {
    const before = previous === null
      ? { github: current.githubConnected, openRouter: current.openRouterConnected }
      : { github: model.prevGithubConnected, openRouter: model.prevOpenRouterConnected }
    const githubJustConnected = !before.github && current.githubConnected
    const openRouterJustConnected = !before.openRouter && current.openRouterConnected
    // The effect's cleanup clears whatever timer the last run set.
    const version = model.advanceVersion + 1
    model = { ...model, prevGithubConnected: current.githubConnected, prevOpenRouterConnected: current.openRouterConnected, advanceVersion: version }
    if (current.open) {
      if (render.step === "github" && githubJustConnected) {
        commands.push(WaitAutoAdvance({ version, to: "agents", ms: AUTO_ADVANCE_MS }))
      } else if (render.step === "openrouter" && openRouterJustConnected) {
        commands.push(WaitAutoAdvance({ version, to: render.cloudStepEnabled ? "cloud" : "done", ms: AUTO_ADVANCE_MS }))
      }
    }
  }

  // Same treatment for the cloud step: let the "you're live" state land, then
  // move on. The machine keeps connecting in the background either way.
  if (changed("open", "step", "machinePaired")) {
    const before = previous === null ? current.machinePaired : model.prevMachinePaired
    const justPaired = !before && current.machinePaired
    const version = model.pairedAdvanceVersion + 1
    model = { ...model, prevMachinePaired: current.machinePaired, pairedAdvanceVersion: version }
    if (current.open && render.step === "cloud" && justPaired) commands.push(WaitPairedAdvance({ version }))
  }

  return { model, commands }
}

/**
 * Runs after any root change: App.tsx's launch decision, then the wizard's
 * effects until they settle (a pass whose state changes is followed by
 * another, as React re-renders and re-runs the effects whose inputs moved).
 */
export function observe(model: Model, _previousApp: AppModel, app: AppModel): Return {
  let next = model
  const commands: WizardCommand[] = []
  let open = app.stores.providerAuth.setupWizardOpen
  let launch: AppAction | null = null

  // Onboarding auto-launch (see getSetupLaunchAction): a first-ever launch
  // opens the wizard instantly (cards show live probe status inside), while
  // later launches wait for the probe round and re-open only when something
  // is still unconnected. Decided at most once per app load; "Set up later"
  // and a completed run are both persisted per machine (server settings, not
  // this browser's localStorage) and suppress future launches everywhere, so
  // we also wait for `setupLoaded` before deciding anything.
  if (!next.launchDecided) {
    const auth = app.stores.providerAuth
    const action = ProviderAuth.getSetupLaunchAction(auth.snapshot, auth)
    if (action !== "wait") {
      next = { ...next, launchDecided: true }
      if (action === "open") {
        launch = providerAuthAction(ProviderAuth.Message.OpenedSetupWizard())
        // The root opens it after this returns; the wizard's effects see it open now.
        open = true
      }
    }
  }

  for (let pass = 0; pass < 10; pass += 1) {
    const current = inputsOf(next, app, open)
    if (sameInputs(next.effectInputs, current)) break
    const ran = runEffects(next, next.effectInputs, current, app)
    next = { ...ran.model, effectInputs: current }
    commands.push(...ran.commands)
  }

  if (next === model && commands.length === 0 && !launch) return { model }
  return {
    model: next,
    commands,
    ...(launch ? { outMessage: SliceOutMessage.RequestedAppAction({ action: launch }) } : {}),
  }
}
