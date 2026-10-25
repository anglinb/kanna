import { Schema } from "effect"
import type { UploadErrorReport } from "../../client/lib/uploadError"
import type { ChatAttachment, HarnessSkill } from "../../shared/types"
import { opaque } from "../core/schema"
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
 * page's chat changes (`reconcile`).
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

  pendingSubmit: Schema.NullOr(PendingSubmit),
})
export type Model = typeof Model.Type

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
    recording: false,
    transcribing: false,
    recorderError: null,
    hold: { phase: "idle", ringShown: false, version: 0, resume: false },
    popovers: {
      account: Popover.init({ id: "composer-account" }),
      provider: Popover.init({ id: "composer-provider" }),
      model: Popover.init({ id: "composer-model" }),
      reasoning: Popover.init({ id: "composer-reasoning" }),
      contextWindow: Popover.init({ id: "composer-context-window" }),
      fastMode: Popover.init({ id: "composer-fast-mode" }),
      mode: Popover.init({ id: "composer-mode" }),
      delegate: Popover.init({ id: "composer-delegate" }),
    },
    modelQuery: "",
    tooltips: {
      inlineMeter: Tooltip.init({ id: "composer-meter-inline", delayDuration: 0 }),
      dockedMeter: Tooltip.init({ id: "composer-meter-docked", delayDuration: 0 }),
    },
    pendingSubmit: null,
  }
}
