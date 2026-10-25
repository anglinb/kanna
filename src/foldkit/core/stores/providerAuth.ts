import { Effect, Schema, Stream } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import {
  authServiceForProvider,
  type AgentProvider,
  type AppSettingsPatch,
  type AuthServiceId,
  type AuthServiceSnapshot,
  type ProviderAuthSnapshot,
} from "../../../shared/types"
import { opaque } from "../schema"
import { KannaSocketService, sendCommand, topicStream } from "../socket"

// Port of src/client/stores/providerAuthStore.ts: sign-in state per service,
// and the setup wizard's open state and machine-wide onboarding flags.
//
// The store kept the app socket (`setSocket`, registered by the layout) so
// deep components could send through it. Here the socket is the app's
// resource: the onboarding writes are `PersistSetupFlags` Commands through
// `sendCommand`, and the store's `socket` field is gone. The layout's
// `provider-auth` subscription is `subscriptions.providerAuth`.

const SnapshotSchema = opaque<ProviderAuthSnapshot>("ProviderAuthSnapshot")

export const Model = Schema.Struct({
  snapshot: Schema.NullOr(SnapshotSchema),
  /** Full-screen setup wizard visibility. */
  setupWizardOpen: Schema.Boolean,
  /**
   * The server's app-settings snapshot has arrived, so the three flags below
   * reflect this machine rather than their pre-load defaults. Until then the
   * auto-launch decision has to wait — otherwise a browser that has never
   * connected would read `false` and re-run onboarding on every new browser.
   */
  setupLoaded: Schema.Boolean,
  /** The wizard has been shown at least once (persisted per machine). */
  setupShown: Schema.Boolean,
  /** The wizard's final step was completed (persisted). Hides the Setup cards. */
  setupCompleted: Schema.Boolean,
  /** "Set up later" was chosen (persisted). Suppresses auto-launch only. */
  setupDismissed: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  snapshot: null,
  setupWizardOpen: false,
  setupLoaded: false,
  setupShown: false,
  setupCompleted: false,
  setupDismissed: false,
}

export const Message = defineMessageUnion({
  ReceivedProviderAuthSnapshot: { snapshot: Schema.NullOr(SnapshotSchema) },
  /** The machine-wide setup flags pushed on the `app-settings` topic. */
  ReceivedSetupFlags: { setupShown: Schema.Boolean, setupCompleted: Schema.Boolean, setupDismissed: Schema.Boolean },
  OpenedSetupWizard: {},
  /** Closed without finishing — persists the dismissal so we never auto-launch again. */
  DismissedSetupWizard: {},
  /** Closed from the final step — persists completion so Setup cards disappear. */
  CompletedSetupWizard: {},
  CompletedPersistSetupFlags: {},
})
export type Message = typeof Message.Type

/**
 * Persist an onboarding marker on the machine. Fire-and-forget: the local
 * flag is already set optimistically, and the server echoes the settings
 * snapshot back on the `app-settings` topic to every connected browser.
 */
export const PersistSetupFlags = Command.define("PersistSetupFlags", {
  args: { patch: opaque<AppSettingsPatch>("AppSettingsPatch") },
  messages: [Message.CompletedPersistSetupFlags],
  execute: ({ patch }) => sendCommand({ type: "settings.writeAppSettingsPatch", patch }).pipe(
    Effect.ignore,
    Effect.as(Message.CompletedPersistSetupFlags()),
  ),
})

type Return = Update.Return<Model, Message, KannaSocketService>

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedProviderAuthSnapshot: ({ snapshot }) => ({ model: { ...model, snapshot } }),
    ReceivedSetupFlags: (flags) => ({
      model: {
        ...model,
        setupLoaded: true,
        // Markers are one-way latches: never let a snapshot un-set a flag this
        // browser just set optimistically while its write is still in flight.
        setupShown: model.setupShown || flags.setupShown,
        setupCompleted: model.setupCompleted || flags.setupCompleted,
        setupDismissed: model.setupDismissed || flags.setupDismissed,
      },
    }),
    OpenedSetupWizard: () => ({
      model: { ...model, setupWizardOpen: true, setupShown: true },
      commands: [PersistSetupFlags({ patch: { setupShown: true } })],
    }),
    DismissedSetupWizard: () => ({
      model: { ...model, setupWizardOpen: false, setupDismissed: true },
      commands: [PersistSetupFlags({ patch: { setupDismissed: true } })],
    }),
    CompletedSetupWizard: () => ({
      model: { ...model, setupWizardOpen: false, setupCompleted: true, setupDismissed: true },
      commands: [PersistSetupFlags({ patch: { setupCompleted: true, setupDismissed: true } })],
    }),
    CompletedPersistSetupFlags: () => ({ model }),
  })

/**
 * Feeds the snapshot for the app's lifetime: sign-in state powers the
 * settings/new-chat auth cards, the harness picker's "Sign In" pills, and the
 * blocked-switch dialog.
 */
export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({
  providerAuth: Subscription.persistentEntry(
    topicStream<ProviderAuthSnapshot>({ type: "provider-auth" }).pipe(
      Stream.map((snapshot) => Message.ReceivedProviderAuthSnapshot({ snapshot })),
    ),
  ),
}))

export function selectAuthService(
  snapshot: ProviderAuthSnapshot | null,
  service: AuthServiceId
): AuthServiceSnapshot | null {
  return snapshot?.services.find((entry) => entry.service === service) ?? null
}

/**
 * Harnesses whose gating auth service is known to be signed out or missing.
 * "unknown"/"error" states don't gate — never block a switch on a failed probe.
 */
export function getUnauthenticatedHarnesses(snapshot: ProviderAuthSnapshot | null): Set<AgentProvider> {
  const result = new Set<AgentProvider>()
  if (!snapshot) return result
  for (const provider of ["claude", "codex", "cursor"] as const) {
    if (snapshot.accounts?.some((account) => account.provider === provider && account.authStatus === "signed_in")) continue
    const serviceId = authServiceForProvider(provider)
    if (!serviceId) continue
    const service = selectAuthService(snapshot, serviceId)
    if (service && (service.authStatus === "signed_out" || service.authStatus === "not_installed")) {
      result.add(provider)
    }
  }
  return result
}

/** `useAuthService`. */
export function authService(model: Model, service: AuthServiceId): AuthServiceSnapshot | null {
  return selectAuthService(model.snapshot, service)
}

const NO_SNAPSHOT = {}
const unauthenticatedCache = new WeakMap<object, Set<AgentProvider>>()

/** `useUnauthenticatedHarnesses`: memoized on the snapshot, as the hook was. */
export function unauthenticatedHarnesses(model: Model): Set<AgentProvider> {
  const key = model.snapshot ?? NO_SNAPSHOT
  let harnesses = unauthenticatedCache.get(key)
  if (!harnesses) {
    harnesses = getUnauthenticatedHarnesses(model.snapshot)
    unauthenticatedCache.set(key, harnesses)
  }
  return harnesses
}

export interface SetupStatus {
  /** Every service the flow cares about has been probed (no "unknown" left). */
  resolved: boolean
  githubConnected: boolean
  /** At least one coding-agent harness (claude/codex/cursor) is signed in. */
  anyAgentConnected: boolean
  openRouterConnected: boolean
  /** Something the wizard covers is still unconnected. */
  missingAny: boolean
}

export function getSetupStatus(snapshot: ProviderAuthSnapshot | null): SetupStatus {
  const services = snapshot?.services ?? []
  const byId = new Map(services.map((service) => [service.service, service]))
  const isConnected = (id: AuthServiceId) => byId.get(id)?.authStatus === "signed_in"
  const relevant: AuthServiceId[] = ["claude", "codex", "cursor", "gh", "openrouter"]
  const resolved = services.length > 0 && relevant.every((id) => {
    const status = byId.get(id)?.authStatus
    return status !== undefined && status !== "unknown"
  })
  const githubConnected = isConnected("gh")
  const anyAgentConnected = isConnected("claude") || isConnected("codex") || isConnected("cursor")
  const openRouterConnected = isConnected("openrouter")
  return {
    resolved,
    githubConnected,
    anyAgentConnected,
    openRouterConnected,
    missingAny: !githubConnected || !anyAgentConnected || !openRouterConnected,
  }
}

/**
 * Auto-launch decision for the setup wizard on app load.
 *
 * The flags are machine-wide (persisted in the server's settings file), so the
 * decision has to wait for the first `app-settings` snapshot — a brand-new
 * browser starts with all three false, and acting on that would re-run
 * onboarding for every browser that ever visits this machine.
 *
 * Once loaded: a first-ever launch ("shown" never persisted) opens IMMEDIATELY
 * — the cards inside render live "Checking…" states as the CLI probes resolve,
 * so there is nothing to wait for; if everything turns out connected the user
 * just sees checks and clicks through. Later launches wait for the probe round
 * (avoids flashing the wizard at fully-set-up users) and re-open only while
 * something the flow covers is still unconnected.
 */
export function getSetupLaunchAction(
  snapshot: ProviderAuthSnapshot | null,
  flags: {
    setupLoaded: boolean
    setupShown: boolean
    setupCompleted: boolean
    setupDismissed: boolean
  }
): "open" | "wait" | "none" {
  if (!flags.setupLoaded) return "wait"
  if (flags.setupCompleted || flags.setupDismissed) return "none"
  if (!flags.setupShown) return "open"
  const status = getSetupStatus(snapshot)
  if (!status.resolved) return "wait"
  return status.missingAny ? "open" : "none"
}

/** `useSetupStatus`. */
export function setupStatus(model: Model): SetupStatus {
  return getSetupStatus(model.snapshot)
}

/**
 * The Setup card (home + new-chat) shows until the wizard has been finished.
 * Gated on `setupLoaded` too, so a machine that already completed setup never
 * flashes the card at a fresh browser while the settings snapshot is in flight.
 */
export function showSetupCard(model: Model): boolean {
  const status = setupStatus(model)
  return model.setupLoaded && status.resolved && status.missingAny && !model.setupCompleted
}
