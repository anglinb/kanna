import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { ChatAttachment, HarnessSkill } from "../../shared/types"
import { opaque } from "../core/schema"
import * as ChatInput from "../core/stores/chatInput"
import { SignInDialogMessage } from "../settings/auth-cards"
import * as AppDialog from "../ui/app-dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import { AgentProviderSchema, FileSchema, PopoverName, TooltipName, UploadErrorReportSchema } from "./model"

const ChatModeSchema = Schema.Literals(["full-access", "plan", "auto-plan"])
const ClaudeContextWindowSchema = Schema.Literals(["200k", "1m"])

export const Message = defineMessageUnion({
  // THE TEXTAREA
  /** Inserted (a new chat, or back from recording): it has focused itself, as autoFocus did. */
  CompletedMountTextarea: {},
  /**
   * A keystroke. `at` is when it happened, so the draft store takes the text
   * in the same update (zustand's set ran inside the input handler): a page
   * left a moment after typing keeps what was typed.
   */
  ChangedInput: { value: Schema.String, caret: Schema.Number, at: Schema.Number },
  /** The selection moved without the text changing (React's onSelect). */
  MovedCaret: { caret: Schema.Number },
  /**
   * A paste the composer handles: images to attach, and when its trailing
   * newlines were trimmed, the text with the paste in it.
   */
  Pasted: { files: Schema.Array(FileSchema), text: Schema.NullOr(Schema.Struct({ value: Schema.String, caret: Schema.Number })) },
  PressedEnter: { withModifier: Schema.Boolean },
  PressedTab: {},
  PressedShiftTab: {},
  /** ArrowUp in an empty composer: the last prompt comes back. */
  RecalledPreviousPrompt: {},
  /** Escape, with a turn to stop and nothing nearer wanting the key: the hold starts. */
  PressedEscapeToStop: {},
  /** A key the composer swallowed and does nothing with (a repeated Escape). */
  IgnoredKey: {},

  // THE "/" AND "@" MENUS
  MovedSkillSelection: { towardWorse: Schema.Boolean },
  AcceptedSkill: { index: Schema.Number },
  HoveredSkill: { index: Schema.Number },
  DismissedSkillMenu: {},
  SucceededListSkills: { provider: AgentProviderSchema, skills: Schema.Array(opaque<HarnessSkill>("HarnessSkill")) },
  FailedListSkills: {},
  MovedProjectSelection: { towardWorse: Schema.Boolean },
  AcceptedProject: { index: Schema.Number },
  HoveredProject: { index: Schema.Number },
  DismissedProjectMenu: {},

  // THE ROUND BUTTON AND THE MIC
  PressedPrimaryAction: { withModifier: Schema.Boolean },
  PressedMic: {},
  PressedDiscardRecording: {},
  StartedRecording: {},
  FailedStartRecording: { error: Schema.String },
  FinishedRecording: { recording: Schema.NullOr(opaque<{ blob: Blob; mimeType: string }>("VoiceRecording")), error: Schema.NullOr(Schema.String) },
  TranscribedRecording: { text: Schema.String },
  FailedTranscribe: { error: Schema.String },
  CompletedMountWaveform: {},

  // HOLD TO STOP
  ConfirmedHold: { version: Schema.Number },
  ReleasedHold: { version: Schema.Number },
  ElapsedHoldTimer: { version: Schema.Number, step: Schema.Literals(["ring", "hint", "confirmed"]) },

  // ATTACHMENTS
  PickedFiles: { files: Schema.Array(FileSchema) },
  StartedUpload: { tempId: Schema.String, file: FileSchema, previewUrl: Schema.NullOr(Schema.String), generation: Schema.Number },
  SucceededUpload: { tempId: Schema.String, attachment: opaque<ChatAttachment>("ChatAttachment"), generation: Schema.Number },
  FailedUpload: { tempId: Schema.String, report: UploadErrorReportSchema, generation: Schema.Number },
  ClickedAttachment: { id: Schema.String },
  ClickedRemoveAttachment: { id: Schema.String },
  ClickedCopyUploadError: {},
  CopiedUploadError: { copied: Schema.Boolean },
  ElapsedCopied: { version: Schema.Number },

  // THE OPTIONS ROW
  GotPopoverMessage: { name: PopoverName, message: Popover.Message },
  GotTooltipMessage: { name: TooltipName, message: Tooltip.Message },
  PickedAccount: { accountId: Schema.String },
  PickedProvider: { provider: AgentProviderSchema },
  PickedModel: { model: Schema.String },
  ChangedModelQuery: { query: Schema.String },
  ClickedEditModels: {},
  PickedReasoningEffort: { effort: Schema.String },
  PickedContextWindow: { contextWindow: ClaudeContextWindowSchema },
  PickedFastMode: { fastMode: Schema.Boolean },
  PickedMode: { mode: ChatModeSchema },
  PickedDelegator: { chatId: Schema.NullOr(Schema.String) },
  ClickedNewDelegator: {},
  GotAppDialogMessage: { message: AppDialog.Message },
  SucceededCreateDelegator: { projectId: Schema.String, chatId: Schema.String },
  FailedCreateDelegator: { error: Schema.String },
  GotSignInMessage: { message: SignInDialogMessage },

  // FROM THE PAGE (ChatInputHandle, the session's answer, page-wide events)
  /** A send is out: its draft (text and files) leaves the store. */
  ClearedDraftAfterSend: { draftId: Schema.String },
  /** The send went through: the draft taken out for it is gone for good. Forwarded from the session's `SucceededSend`. */
  SucceededSend: {},
  /** The send failed: the draft comes back. Forwarded from the session's `FailedSend`. */
  FailedSend: { content: Schema.String, error: Schema.String },
  /** `prefill`: text to finish, after what is there. */
  RequestedPrefill: { text: Schema.String },
  /** `enqueueFiles`: files dropped on the page, or attached by the viewer. */
  ReceivedFiles: { files: Schema.Array(FileSchema) },
  ChangedStandalone: { matches: Schema.Boolean },
  /**
   * The root Model changed under the composer (an `observe`): what it does
   * on its own follows (a harness switch waiting on sign-in applies once
   * the harness is signed in; a draft cleared elsewhere empties the box).
   */
  ObservedApp: {},

  // PLUMBING
  /** A store write stamped with the time (core/stores/chatInput's Commands). */
  GotChatInputStoreMessage: { message: ChatInput.Message },
  CompletedMountComposer: {},
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
