import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import type { ChatAttachment, HarnessSkill } from "../../shared/types"
import { AppAction } from "../app/action"
import { opaque } from "../core/schema"
import * as ChatInput from "../core/stores/chatInput"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import { AgentProviderSchema, FileSchema, PopoverName, TooltipName, UploadErrorReportSchema } from "./model"

const ChatModeSchema = Schema.Literals(["full-access", "plan", "auto-plan"])
const ClaudeContextWindowSchema = Schema.Literals(["200k", "1m"])

export const Message = defineMessageUnion({
  // THE TEXTAREA
  /** Inserted (a new chat, or back from recording): it has focused itself, as autoFocus did. */
  CompletedMountTextarea: {},
  ChangedInput: { value: Schema.String, caret: Schema.Number },
  /** The selection moved without the text changing (React's onSelect). */
  MovedCaret: { caret: Schema.Number },
  /** A paste whose trailing newlines were trimmed: the text with the paste in it. */
  PastedText: { value: Schema.String, caret: Schema.Number },
  PastedFiles: { files: Schema.Array(FileSchema) },
  PressedEnter: { withModifier: Schema.Boolean },
  PressedTab: {},
  PressedShiftTab: {},
  /** ArrowUp in an empty composer: the last prompt comes back. */
  RecalledPreviousPrompt: {},
  /** Escape, with a turn to stop and nothing nearer wanting the key: the hold starts. */
  PressedEscapeToStop: {},

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

  // FROM THE PAGE (ChatInputHandle, the session's answer, page-wide events)
  /** The send went through: the draft taken out for it is gone for good. Forwarded from the session's `SucceededSend`. */
  SucceededSend: {},
  /** The send failed: the draft comes back. Forwarded from the session's `FailedSend`. */
  FailedSend: { content: Schema.String, error: Schema.String },
  /** `prefill`: text to finish, after what is there. */
  RequestedPrefill: { text: Schema.String },
  /** `enqueueFiles`: files dropped on the page, or attached by the viewer. */
  ReceivedFiles: { files: Schema.Array(FileSchema) },

  // PLUMBING
  /** A store write stamped with the time (core/stores/chatInput's Commands). */
  GotChatInputStoreMessage: { message: ChatInput.Message },
  /** One more AppAction from the same step: an update hands the root one at a time. */
  RequestedAction: { action: AppAction },
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
