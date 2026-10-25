import { Schema } from "effect"
import type { UploadErrorReport } from "../../client/lib/uploadError"
import type { ChatAttachment, HarnessSkill } from "../../shared/types"
import { opaque } from "../core/schema"
import { initSignInDialog, SignInDialogModel } from "../settings/auth-cards"
import * as AppDialog from "../ui/app-dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"

// The composer's own state: what ChatInput held in useState and refs, and
// the open state of the pickers and tooltips it draws.

export interface ComposerAttachment extends ChatAttachment {
  status: "uploading" | "uploaded" | "failed"
  previewUrl?: string
}

export const AgentProviderSchema = Schema.Literals(["claude", "codex", "cursor", "grok", "pi"])

export const ComposerAttachmentSchema = opaque<ComposerAttachment>("ComposerAttachment")
export const UploadErrorReportSchema = opaque<UploadErrorReport>("UploadErrorReport")
export const FileSchema = opaque<File>("File")

/**
 * Which composer this Model holds. React remounted ChatInput per chat
 * (`key={activeChatId ?? "new-chat"}`); here the Model is reset when the
 * page's chat changes (`reconcile`), and the view is keyed the same way.
 */
export const Instance = Schema.Struct({
  chatKey: Schema.String,
  draftId: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(Schema.String),
  secondary: Schema.Boolean,
  /** `data-composer` on the textarea, so Commands and Subscriptions find this one. */
  domId: Schema.String,
})
export type Instance = typeof Instance.Type

/**
 * - `holding`: the key is down and the ring is drawing.
 * - `released`: let go early. The ring has gone back; the hint stays a moment.
 * - `confirmed`: held to the end. The ring stays closed until the turn stops.
 */
export const HoldPhase = Schema.Literals(["idle", "holding", "released", "confirmed"])
export type HoldPhase = typeof HoldPhase.Type

export const PopoverName = Schema.Literals(["account", "provider", "model", "reasoning", "contextWindow", "fastMode", "mode", "delegate"])
export type PopoverName = typeof PopoverName.Type
export const POPOVER_NAMES: ReadonlyArray<PopoverName> = ["account", "provider", "model", "reasoning", "contextWindow", "fastMode", "mode", "delegate"]

export const TooltipName = Schema.Literals(["inlineMeter", "dockedMeter"])
export type TooltipName = typeof TooltipName.Type

/** What a send took out of the composer, to put back if it fails (handleSubmit's catch). */
export const PendingSubmit = Schema.Struct({
  kind: Schema.Literals(["typed", "voice"]),
  value: Schema.String,
  attachments: Schema.Array(ComposerAttachmentSchema),
  uploadError: Schema.NullOr(UploadErrorReportSchema),
})
export type PendingSubmit = typeof PendingSubmit.Type

export const Model = Schema.Struct({
  instance: Schema.NullOr(Instance),
  value: Schema.String,
  /** What was last written to the draft store, to tell an outside clear from a write still on its way. */
  writtenDraft: Schema.NullOr(Schema.String),
  /** The textarea's selectionStart, as `caretPosition` mirrored it. */
  caret: Schema.Number,

  attachments: Schema.Array(ComposerAttachmentSchema),
  uploadQueue: Schema.Array(FileSchema),
  activeUploads: Schema.Number,
  uploadGeneration: Schema.Number,
  removedAttachmentIds: Schema.Array(Schema.String),
  uploadError: Schema.NullOr(UploadErrorReportSchema),
  uploadErrorCopied: Schema.Boolean,
  copiedVersion: Schema.Number,

  skills: Schema.NullOr(Schema.Array(opaque<HarnessSkill>("HarnessSkill"))),
  skillsFetch: Schema.Struct({ provider: Schema.NullOr(AgentProviderSchema), pending: Schema.Boolean }),
  skillMenuDismissed: Schema.Boolean,
  /** Offset from the BOTTOM of the rendered list (0 = best match, adjacent to the input). */
  skillMenuOffset: Schema.Number,
  projectMenuDismissed: Schema.Boolean,
  projectMenuOffset: Schema.Number,

  accountChoices: Schema.Record(Schema.String, Schema.String),
  /** A harness picked while signed out: the switch waits for sign-in. */
  pendingSignInProvider: Schema.NullOr(AgentProviderSchema),
  signIn: SignInDialogModel,

  recording: Schema.Boolean,
  transcribing: Schema.Boolean,
  recorderError: Schema.NullOr(Schema.String),

  hold: Schema.Struct({ phase: HoldPhase, ringShown: Schema.Boolean, version: Schema.Number, resume: Schema.Boolean }),

  popovers: Schema.Struct({
    account: Popover.Model,
    provider: Popover.Model,
    model: Popover.Model,
    reasoning: Popover.Model,
    contextWindow: Popover.Model,
    fastMode: Popover.Model,
    mode: Popover.Model,
    delegate: Popover.Model,
  }),
  /** The model picker's filter box. */
  modelQuery: Schema.String,
  tooltips: Schema.Struct({ inlineMeter: Tooltip.Model, dockedMeter: Tooltip.Model }),

  /** useIsStandalone: an installed web app. */
  isStandalone: Schema.Boolean,
  /** createDelegator's prompt and its alert (useAppDialog). */
  appDialog: AppDialog.Model,

  pendingSubmit: Schema.NullOr(PendingSubmit),
})
export type Model = typeof Model.Type

const STANDALONE_QUERY = "(display-mode: standalone)"

export function isStandaloneNow() {
  if (typeof window === "undefined") return false
  const isIOSStandalone = (navigator as { standalone?: boolean }).standalone === true
  return isIOSStandalone || (typeof window.matchMedia === "function" && window.matchMedia(STANDALONE_QUERY).matches)
}

export { STANDALONE_QUERY }

export function popoversFor(domId: string): Model["popovers"] {
  return Object.fromEntries(POPOVER_NAMES.map((name) => [name, Popover.init({ id: `${domId}-${name}` })])) as Model["popovers"]
}

export function tooltipsFor(domId: string): Model["tooltips"] {
  return {
    inlineMeter: Tooltip.init({ id: `${domId}-meter-inline`, delayDuration: 0 }),
    dockedMeter: Tooltip.init({ id: `${domId}-meter-docked`, delayDuration: 0 }),
  }
}

export function init(): Model {
  return {
    instance: null,
    value: "",
    writtenDraft: null,
    caret: 0,
    attachments: [],
    uploadQueue: [],
    activeUploads: 0,
    uploadGeneration: 0,
    removedAttachmentIds: [],
    uploadError: null,
    uploadErrorCopied: false,
    copiedVersion: 0,
    skills: null,
    skillsFetch: { provider: null, pending: false },
    skillMenuDismissed: false,
    skillMenuOffset: 0,
    projectMenuDismissed: false,
    projectMenuOffset: 0,
    accountChoices: {},
    pendingSignInProvider: null,
    signIn: initSignInDialog({ id: "composer-sign-in" }),
    recording: false,
    transcribing: false,
    recorderError: null,
    hold: { phase: "idle", ringShown: false, version: 0, resume: false },
    popovers: popoversFor("composer"),
    modelQuery: "",
    tooltips: tooltipsFor("composer"),
    isStandalone: isStandaloneNow(),
    appDialog: AppDialog.init(),
    pendingSubmit: null,
  }
}
