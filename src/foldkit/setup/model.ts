import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { initialMacSetupState, macSetupAvailable, type MacSetupState } from "../core/macApp"
import { opaque } from "../core/schema"
import * as AuthCard from "../settings/auth-cards"
import * as CloudPair from "../settings/cloud-pair"

// The setup wizard's state (components/auth/SetupWizard.tsx). React kept it
// in useState and refs, and moved it on in effects; here the same fields sit
// in the Model, and `observe` (update.ts) runs those effects whenever the
// root changes.

/**
 * The cloud step is dropped entirely when this machine can't use it (already
 * paired, or a run that can't pair in place), so the progress bar never
 * promises a step that won't appear. The This Mac step exists only in Kanna
 * for Mac (rows.ts), and comes first: Full Disk Access can make macOS quit
 * and reopen the app, better before anything else is under way.
 */
export const BASE_STEPS = ["github", "agents", "openrouter"] as const

export const SetupStep = Schema.Literals(["mac", "github", "agents", "openrouter", "cloud", "done"])
export type SetupStep = typeof SetupStep.Type

export const Direction = Schema.Literals(["open", "forward", "back", "finish"])
export type Direction = typeof Direction.Type

/**
 * What the effects last ran on (their dependency arrays), so a change can
 * be told from a repeat. Null before the first run, as on mount.
 */
export const EffectInputs = Schema.Struct({
  open: Schema.Boolean,
  /** useCloudPairSession's `enabled`: open, on a server that can use Kanna Cloud. */
  cloudEnabled: Schema.Boolean,
  cloudLoaded: Schema.Boolean,
  cloudStatus: Schema.String,
  ghKnown: Schema.Boolean,
  githubConnected: Schema.Boolean,
  openRouterConnected: Schema.Boolean,
  machinePaired: Schema.Boolean,
  step: SetupStep,
  cloudStepEnabled: Schema.Boolean,
})
export type EffectInputs = typeof EffectInputs.Type

const MacState = opaque<MacSetupState>("MacSetupState")

export const Model = Schema.Struct({
  step: SetupStep,
  /** App.tsx's launch rule: decided at most once per load. */
  launchDecided: Schema.Boolean,
  wasOpen: Schema.Boolean,
  /** A property of the page (the app, this Mac's own server), not of the run. */
  macStepEnabled: Schema.Boolean,
  /** useMacSetupStore: what Kanna for Mac last reported. */
  macState: Schema.NullOr(MacState),
  /**
   * GitHub already connected (say, gh signed in before Kanna existed): no
   * step to show. Decided once gh's status is known, not on open: a first
   * launch opens before the provider checks finish, and "not checked yet"
   * isn't "not connected". Never pulled away from under the user, though.
   */
  githubStepEnabled: Schema.Boolean,
  githubDecided: Schema.Boolean,
  /**
   * Decided once per open, from the first status that lands: a machine that
   * pairs mid-wizard must not yank its own step out from under itself.
   */
  cloudStepEnabled: Schema.Boolean,
  cloudDecided: Schema.Boolean,
  cloudStarted: Schema.Boolean,
  /** Kanna for Mac's Put This Mac Online… opens the wizard at the Kanna Cloud step. */
  requestedStep: Schema.NullOr(Schema.Literal("cloud")),
  /** The step on its way out, drawn inert for its short exit (index.css .wizard-leave). */
  leaving: Schema.NullOr(Schema.Struct({
    from: SetupStep,
    direction: Schema.Literals(["forward", "back"]),
    id: Schema.Number,
  })),
  leaveCount: Schema.Number,
  enterDirection: Direction,
  /** useCloudPairSession and the CloudPairPanel's own bits. */
  cloud: CloudPair.Model,
  /** The cards of the step on screen (and the one leaving), by step and AuthCard.cardId. */
  cards: Schema.Record(Schema.String, AuthCard.Model),
  effectInputs: Schema.NullOr(EffectInputs),
  /** The auto-advance effects' refs: the values their last run saw. */
  prevGithubConnected: Schema.Boolean,
  prevOpenRouterConnected: Schema.Boolean,
  prevMachinePaired: Schema.Boolean,
  /** Bumped when an auto-advance timer is cleared, so a stale one does nothing. */
  advanceVersion: Schema.Number,
  pairedAdvanceVersion: Schema.Number,
})
export type Model = typeof Model.Type

export function init(): Model {
  const idleCloud = CloudPair.init()
  return {
    step: "github",
    launchDecided: false,
    wasOpen: false,
    macStepEnabled: macSetupAvailable(),
    macState: initialMacSetupState(),
    githubStepEnabled: true,
    githubDecided: false,
    cloudStepEnabled: false,
    cloudDecided: false,
    cloudStarted: false,
    requestedStep: null,
    leaving: null,
    leaveCount: 0,
    enterDirection: "open",
    cloud: idleCloud,
    cards: {},
    effectInputs: null,
    prevGithubConnected: false,
    prevOpenRouterConnected: false,
    prevMachinePaired: false,
    advanceVersion: 0,
    pairedAdvanceVersion: 0,
  }
}

export const Message = defineMessageUnion({
  /** `window.__kannaOpenSetup(step?)`: Kanna › Setup… and Fleet › Put This Mac Online… in the Mac app. */
  RequestedOpen: { step: Schema.NullOr(Schema.Literal("cloud")) },
  ClickedSetUpLater: {},
  ClickedContinue: {},
  ClickedBack: {},
  ClickedSkip: {},
  ClickedStartBuilding: {},
  /** The leaving step's own exit animation ended. */
  EndedLeaving: { id: Schema.Number },
  ElapsedAutoAdvance: { version: Schema.Number, to: SetupStep },
  ElapsedPairedAdvance: { version: Schema.Number },
  ReceivedMacState: { state: MacState },
  ClickedOpenLoginItems: {},
  ToggledLoginItem: { enabled: Schema.Boolean },
  ToggledKeepAwake: { onPower: Schema.Boolean },
  ToggledKeepAwakeOnBattery: { onBattery: Schema.Boolean },
  ClickedOpenFullDiskAccess: {},
  CompletedMacRequest: {},
  GotAuthCardMessage: { id: Schema.String, message: AuthCard.Message },
  GotCloudMessage: { message: CloudPair.Message },
})
export type Message = typeof Message.Type
