import { Option } from "effect"
import { Command } from "foldkit"
import { classifyAttachmentPreview } from "../../client/components/messages/attachmentPreview"
import { applyProjectMention, getActiveProjectMention } from "../../client/lib/project-mention"
import { applySkillCompletion } from "../../client/lib/skill-menu"
import { simpleUploadError } from "../../client/lib/uploadError"
import type { AgentProvider, ChatMode, ClaudeContextWindow } from "../../shared/types"
import { AppAction, batch } from "../app/action"
import type { AppModel, SliceReturn } from "../app/slice"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import * as ChatSession from "../core/chatSession"
import type { KannaSocketService } from "../core/socket"
import * as ChatInput from "../core/stores/chatInput"
import * as ChatPreferences from "../core/stores/chatPreferences"
import type { ComposerState } from "../core/stores/chatPreferences"
import * as Delegate from "../core/stores/delegate"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as Viewer from "../core/stores/viewer"
import { closeSignInDialog, openSignInDialog, updateSignInDialog, type SignInDialogMessage } from "../settings/auth-cards"
import * as AppDialog from "../ui/app-dialog"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import * as Commands from "./commands"
import {
  accountsOf,
  buildSubmitOptions,
  canSubmit,
  chatKeyOf,
  composerViewOf,
  contextFromApp,
  delegateSettingsOf,
  draftIdOf,
  hasPendingUploads,
  hydrateComposerAttachments,
  menusOf,
  storedAttachmentDrafts,
  storedDraft,
  toChatAttachment,
  uploadedAttachments,
  type Context,
} from "./context"
import { applyModelToComposerState, isModelSelectable } from "./controls"
import { Message } from "./message"
import { init, popoversFor, tooltipsFor, type ComposerAttachment, type Instance, type Model, type PopoverName } from "./model"

// ChatInput's handlers and effects, as one update. The effects that watched
// a value (the draft id, the project, the "/" query, the attachments) run as
// `reconcile` before a Message and `finish` after it.

/** Max files queued and staged at once. */
export const MAX_FILES_PER_DROP = 50
const MAX_CONCURRENT_UPLOADS = 3

export function willExceedAttachmentLimit(args: {
  currentAttachmentCount: number
  queuedAttachmentCount: number
  incomingAttachmentCount: number
  maxAttachments?: number
}) {
  const maxAttachments = args.maxAttachments ?? MAX_FILES_PER_DROP
  return args.currentAttachmentCount + args.queuedAttachmentCount + args.incomingAttachmentCount > maxAttachments
}

type AnyCommand = Command.Command<Message, never, KannaSocketService>
type Return = SliceReturn<Model, Message>

/** What one step asks for: Commands, and AppActions for the root, in order. */
interface Step {
  model: Model
  commands?: ReadonlyArray<AnyCommand>
  actions?: ReadonlyArray<AppAction>
  /** The step saw to the draft store itself (a send): `finish` writes nothing there. */
  draftHandled?: boolean
}

const store = (message: Stores.Message) => AppAction.Store({ message })
const chatInputAction = (message: ChatInput.Message) => store(Stores.Message.GotChatInputMessage({ message }))
const preferencesAction = (message: ChatPreferences.Message) => store(Stores.Message.GotChatPreferencesMessage({ message }))

// RECONCILE: the composer the page shows now

function instanceOf(ctx: Context, previous: Instance | null): Instance {
  const domId = ctx.props.secondary ? "composer-secondary" : "composer"
  return {
    chatKey: chatKeyOf(ctx.props),
    draftId: draftIdOf(ctx.props),
    projectId: ctx.props.projectId ?? null,
    secondary: ctx.props.secondary,
    domId: previous?.domId ?? domId,
  }
}

function previewUrls(attachments: ReadonlyArray<ComposerAttachment>): string[] {
  return attachments.flatMap((attachment) => (attachment.previewUrl ? [attachment.previewUrl] : []))
}

/**
 * A fresh composer for `instance`: React's remount under a new key. What
 * isn't the composer's own (whether the app is installed) carries over.
 */
function freshModel(instance: Instance, ctx: Context, previous: Model): Model {
  const value = storedDraft(ctx, instance.draftId) ?? ""
  return {
    ...init(),
    instance,
    value,
    writtenDraft: value === "" ? null : value,
    attachments: hydrateComposerAttachments(storedAttachmentDrafts(ctx, instance.draftId)),
    popovers: popoversFor(instance.domId),
    tooltips: tooltipsFor(instance.domId),
    isStandalone: previous.isStandalone,
    appDialog: previous.appDialog,
  }
}

/** clearAttachments: everything staged goes, and uploads still running are disowned. */
function clearAttachments(model: Model, cleanupPreviews: boolean): Step {
  return {
    model: {
      ...model,
      uploadGeneration: model.uploadGeneration + 1,
      removedAttachmentIds: [],
      attachments: [],
      uploadQueue: [],
      activeUploads: 0,
      uploadError: null,
    },
    commands: cleanupPreviews && previewUrls(model.attachments).length > 0
      ? [Commands.RevokePreviews({ urls: previewUrls(model.attachments) })]
      : [],
  }
}

/**
 * Brings the Model up to the page: another chat (a fresh composer), another
 * project (staged files go), a draft cleared from outside (the sidebar's
 * Clear Draft), a harness switch (its skills list goes), a turn that ended
 * under a hold. Pure: the view draws from it too.
 */
export function reconcile(model: Model, ctx: Context): Step {
  const commands: AnyCommand[] = []
  const actions: AppAction[] = []
  let next = model
  const instance = instanceOf(ctx, model.instance)

  if (!model.instance || model.instance.chatKey !== instance.chatKey || model.instance.draftId !== instance.draftId) {
    if (model.instance) {
      const urls = previewUrls(model.attachments)
      if (urls.length > 0) commands.push(Commands.RevokePreviews({ urls }))
      if (model.recording) commands.push(Commands.CancelRecording({ key: model.instance.domId }))
    }
    next = freshModel(instance, ctx, model)
  } else if (model.instance.projectId !== instance.projectId || model.instance.secondary !== instance.secondary) {
    next = { ...next, instance }
    // A project switch empties the staging area: those files are on the
    // other project's machine path.
    if (model.instance.projectId !== null && instance.projectId !== model.instance.projectId) {
      const cleared = clearAttachments(next, true)
      next = cleared.model
      commands.push(...(cleared.commands ?? []))
      if (instance.draftId) actions.push(chatInputAction(ChatInput.Message.ClearedAttachmentDrafts({ chatId: instance.draftId })))
    }
  }

  // The composer owns the text and mirrors it into the store, so a draft
  // cleared from outside would otherwise sit here and be saved again on the
  // next keystroke. Only ever empties: an outside *edit* has no claim on
  // what you're typing.
  if (instance.draftId && next.writtenDraft && storedDraft(ctx, instance.draftId) === undefined) {
    next = { ...next, value: "", writtenDraft: null }
  }

  // Each harness has its own skills.
  const selectedProvider = composerViewOf(ctx).selectedProvider
  if (next.skillsFetch.provider !== null && next.skillsFetch.provider !== selectedProvider) {
    next = { ...next, skills: null, skillsFetch: { provider: null, pending: false } }
  }

  // The turn is over: there is nothing left to show a hold for.
  if (!ctx.props.canCancel && (next.hold.phase !== "idle" || next.hold.ringShown)) {
    next = { ...next, hold: { phase: "idle", ringShown: false, version: next.hold.version + 1, resume: false } }
    commands.push(Commands.EmptyRing({ domId: instance.domId, instant: true }))
  }

  return { model: next, commands, actions }
}

// FINISH: the effects that follow a change

function persistedKey(model: Model) {
  return uploadedAttachments(model).map((attachment) => `${attachment.id}:${attachment.contentUrl}`).join("|")
}

function finish(before: Model, step: Step, ctx: Context): Step {
  let model = step.model
  const commands: AnyCommand[] = [...(step.commands ?? [])]
  const actions: AppAction[] = [...(step.actions ?? [])]
  const domId = model.instance?.domId ?? "composer"
  const draftId = model.instance?.draftId ?? null
  const view = composerViewOf(ctx)
  const menusBefore = menusOf(before, ctx, view.selectedProvider)
  const menus = menusOf(model, ctx, view.selectedProvider)

  if (model.value !== before.value) {
    if (draftId && !step.draftHandled) commands.push(Commands.changeDraft(draftId, model.value))
    commands.push(Commands.AutoResize({ domId }))
  }

  // The "/" menu: closed, it forgets; the highlight goes back to the best
  // match when the query changes; Escape closes it for the token it was
  // pressed in, and the next token opens it again.
  if (!menus.skillMention) {
    if (model.skillMenuDismissed || model.skillMenuOffset !== 0) model = { ...model, skillMenuDismissed: false, skillMenuOffset: 0 }
  } else {
    if (menus.skillMention.query !== menusBefore.skillMention?.query) model = { ...model, skillMenuOffset: 0 }
    if (menus.skillMention.start !== (menusBefore.skillMention?.start ?? null)) model = { ...model, skillMenuDismissed: false }
  }
  if (!menus.projectMention) {
    if (model.projectMenuDismissed) model = { ...model, projectMenuDismissed: false }
  }
  if (menus.projectMention?.query !== menusBefore.projectMention?.query) model = { ...model, projectMenuOffset: 0 }

  // The highlighted row stays in view as it moves.
  const after = menusOf(model, ctx, view.selectedProvider)
  if (
    (after.skillMenuOpen && (!menusBefore.skillMenuOpen || after.selectedSkillIndex !== menusBefore.selectedSkillIndex))
    || (after.projectMenuOpen && (!menusBefore.projectMenuOpen || after.selectedProjectIndex !== menusBefore.selectedProjectIndex))
  ) {
    commands.push(Commands.RevealSelected({ domId }))
  }

  // Refetch on every menu-open transition (skills change on disk and via
  // harness pushes); the stale list stays drawn while the fetch runs.
  if (menus.skillMention && !model.skillsFetch.pending && !(model.skillsFetch.provider === view.selectedProvider && model.skills !== null)) {
    model = { ...model, skillsFetch: { provider: view.selectedProvider, pending: true } }
    commands.push(Commands.ListSkills({ provider: view.selectedProvider, chatId: ctx.props.chatId, projectId: ctx.props.projectId }))
  }

  // The uploaded files are the attachment draft.
  if (draftId && !step.draftHandled && persistedKey(model) !== persistedKey(before)) {
    const persisted = uploadedAttachments(model).map(toChatAttachment)
    if (persisted.length === 0) actions.push(chatInputAction(ChatInput.Message.ClearedAttachmentDrafts({ chatId: draftId })))
    else commands.push(Commands.changeAttachmentDrafts(draftId, persisted))
  }

  // A switch blocked on sign-in applies once the harness is signed in.
  if (model.pendingSignInProvider && !ProviderAuth.unauthenticatedHarnesses(ctx.stores.providerAuth).has(model.pendingSignInProvider)) {
    actions.push(...selectProviderActions(ctx, model.pendingSignInProvider))
    const closed = closeSignInDialog(model.signIn)
    model = { ...model, pendingSignInProvider: null, signIn: closed.model }
    commands.push(...Command.mapMessages(closed.commands ?? [], (message: SignInDialogMessage) => Message.GotSignInMessage({ message })))
  }

  // Housekeeping: once the server confirms the switch (the chat's session
  // provider now matches the staged one), the staged switch is complete.
  const activeProvider = delegateSettingsOf(ctx.props)?.provider ?? ctx.props.activeProvider
  if (activeProvider && view.effectiveState.provider === activeProvider && ChatPreferences.hasPendingProviderSwitch(ctx.stores.chatPreferences, view.composerChatId)) {
    actions.push(preferencesAction(ChatPreferences.Message.ClearedPendingProviderSwitch({ chatId: view.composerChatId })))
  }

  return { model, commands, actions }
}

/** The step's AppActions to the root, in order: one, or a batch. */
function toReturn(step: Step): Return {
  const actions = step.actions ?? []
  const action = actions.length === 0 ? null : actions.length === 1 ? actions[0]! : batch(...actions)
  return {
    model: step.model,
    commands: [...(step.commands ?? [])],
    ...(action ? { outMessage: SliceOutMessage.RequestedAppAction({ action }) } : {}),
  }
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  return updateWith(model, message, contextFromApp(app))
}

/**
 * The slice contract's `observe`, for the chat page to call from its own:
 * React's effects on the auth store (a switch waiting on sign-in) and on
 * the stored draft (cleared from the sidebar) ran without the composer
 * doing anything. Nothing happens unless one of those moved.
 */
export function observe(model: Model, previousApp: AppModel, app: AppModel): Return {
  const authChanged = previousApp.stores.providerAuth !== app.stores.providerAuth && model.pendingSignInProvider !== null
  const draftId = model.instance?.draftId
  const draftChanged = draftId !== null && draftId !== undefined && previousApp.stores.chatInput.drafts[draftId] !== app.stores.chatInput.drafts[draftId]
  if (!authChanged && !draftChanged) return { model }
  return update(model, Message.ObservedApp(), app)
}

/** `update`, with the page's props given (the chat page's own, or a gallery's). */
export function updateWith(model: Model, message: Message, ctx: Context): Return {
  const reconciled = reconcile(model, ctx)
  const stepped = step(reconciled.model, message, ctx)
  const finished = finish(reconciled.model, stepped, ctx)
  return toReturn({
    model: finished.model,
    commands: [...(reconciled.commands ?? []), ...(finished.commands ?? [])],
    actions: [...(reconciled.actions ?? []), ...(finished.actions ?? [])],
  })
}

// THE COMPOSER STATE (useComposer's mutations)

function selectProviderActions(ctx: Context, provider: AgentProvider): AppAction[] {
  const view = composerViewOf(ctx)
  const activeProvider = delegateSettingsOf(ctx.props)?.provider ?? ctx.props.activeProvider
  return [
    preferencesAction(ChatPreferences.Message.ResetChatComposerFromProvider({ chatId: view.composerChatId, provider })),
    // Explicit switch on a started chat: applied by the server on the next
    // send (fresh session + handoff).
    activeProvider !== null && provider !== activeProvider
      ? preferencesAction(ChatPreferences.Message.MarkedPendingProviderSwitch({ chatId: view.composerChatId }))
      : preferencesAction(ChatPreferences.Message.ClearedPendingProviderSwitch({ chatId: view.composerChatId })),
  ]
}

function setComposerState(ctx: Context, transform: (state: ComposerState) => ComposerState): AppAction {
  const view = composerViewOf(ctx)
  return preferencesAction(ChatPreferences.Message.ChangedComposerState({ chatId: view.composerChatId, composerState: transform(view.effectiveState) }))
}

function modeActions(ctx: Context, mode: ChatMode): AppAction[] {
  const view = composerViewOf(ctx)
  // The availability registry is the gate: codex never offers "auto-plan",
  // cursor/pi offer nothing at all.
  if (!view.optionControls.mode?.options.includes(mode)) return []
  return [preferencesAction(ChatPreferences.Message.ChangedChatComposerMode({ chatId: view.composerChatId, mode }))]
}

// POPOVERS

function foldPopover(model: Model, name: PopoverName, result: ReturnType<typeof Popover.update>): Step {
  let next: Model = { ...model, popovers: { ...model.popovers, [name]: result.model } }
  // The model picker's filter lived in a component the popover unmounted.
  if (name === "model" && result.outMessage?._tag === "Opened") next = { ...next, modelQuery: "" }
  return {
    model: next,
    commands: Command.mapMessages(result.commands ?? [], (message: Popover.Message) => Message.GotPopoverMessage({ name, message })),
  }
}

/** The menu's `close()`. */
function closePopover(model: Model, name: PopoverName): Step {
  return foldPopover(model, name, Popover.close(model.popovers[name]))
}

function withCommands(step: Step, commands: ReadonlyArray<AnyCommand>, actions: ReadonlyArray<AppAction> = []): Step {
  return { model: step.model, commands: [...(step.commands ?? []), ...commands], actions: [...(step.actions ?? []), ...actions] }
}

// THE APP DIALOG (createDelegator's prompt and alert)

const CREATE_DELEGATOR_REQUEST = "create-delegator:"

function openAppDialog(step: Step, request: AppDialog.Request): Step {
  const opened = AppDialog.open(step.model.appDialog, request)
  return withCommands(
    { ...step, model: { ...step.model, appDialog: opened.model } },
    Command.mapMessages(opened.commands ?? [], (message: AppDialog.Message) => Message.GotAppDialogMessage({ message })),
  )
}

// ATTACHMENTS

function processUploadQueue(model: Model, ctx: Context): Step {
  if (!ctx.props.projectId) return { model }
  const commands: AnyCommand[] = []
  let next = model
  while (next.activeUploads < MAX_CONCURRENT_UPLOADS && next.uploadQueue.length > 0) {
    const [file, ...rest] = next.uploadQueue
    if (!file) break
    next = { ...next, uploadQueue: rest, activeUploads: next.activeUploads + 1 }
    commands.push(Commands.StartUpload({ file, generation: next.uploadGeneration }))
  }
  return { model: next, commands }
}

function enqueueFiles(model: Model, files: ReadonlyArray<File>, ctx: Context): Step {
  if (!ctx.props.projectId) {
    return { model: { ...model, uploadError: simpleUploadError("Open a project before uploading files.") } }
  }
  if (willExceedAttachmentLimit({
    currentAttachmentCount: model.attachments.length,
    queuedAttachmentCount: model.uploadQueue.length,
    incomingAttachmentCount: files.length,
  })) {
    return { model: { ...model, uploadError: simpleUploadError(`You can upload up to ${MAX_FILES_PER_DROP} files at a time.`) } }
  }
  return processUploadQueue({ ...model, uploadQueue: [...model.uploadQueue, ...files], uploadError: null }, ctx)
}

/** An upload came back: one fewer running, and the next can start. */
function uploadSettled(model: Model, ctx: Context, step: Step): Step {
  const settled = processUploadQueue({ ...step.model, activeUploads: Math.max(0, step.model.activeUploads - 1) }, ctx)
  return withCommands({ model: settled.model, commands: step.commands, actions: step.actions }, settled.commands ?? [])
}

// SUBMIT

function submit(model: Model, ctx: Context, withModifier: boolean): Step {
  if (!canSubmit(model) || hasPendingUploads(model)) return { model }
  const domId = model.instance?.domId ?? "composer"
  const draftId = model.instance?.draftId ?? null
  const attachmentsForSubmit = uploadedAttachments(model).map(toChatAttachment)
  const options = buildSubmitOptions(model, ctx, attachmentsForSubmit, withModifier)
  const cleared = clearAttachments(model, false)
  return {
    model: {
      ...cleared.model,
      value: "",
      pendingSubmit: { kind: "typed", value: model.value, attachments: model.attachments, uploadError: model.uploadError },
    },
    // The draft goes once the send is out (`ClearDraftAfterSend`): React
    // cleared it first, but what that cleared reached the server (draft
    // protection) only after the render, behind the send.
    commands: [Commands.ResetHeight({ domId }), ...(draftId ? [Commands.ClearDraftAfterSend({ draftId })] : [])],
    actions: [AppAction.Chat({ message: ChatSession.Message.SubmittedMessage({ content: model.value, options }) })],
    draftHandled: true,
  }
}

/** What the round button does. Stop is immediate here; only the key is held. */
function runPrimaryAction(model: Model, ctx: Context, withModifier: boolean): Step {
  const { canCancel, disabled } = ctx.props
  // Under a hold the button reads Stop, so that is what a click on it does.
  if ((model.hold.phase === "holding" || model.hold.phase === "confirmed") && canCancel) {
    return { model, actions: [AppAction.Chat({ message: ChatSession.Message.ClickedCancel() })] }
  }
  // Anything sendable (text or attachments alone) wins over cancel, so a
  // file-only message queues instead of stopping the running turn.
  if (!disabled && canSubmit(model) && !hasPendingUploads(model)) return submit(model, ctx, withModifier)
  if (canCancel) return { model, actions: [AppAction.Chat({ message: ChatSession.Message.ClickedCancel() })] }
  return { model }
}

/** Text put in by the composer itself, with the caret placed after it. */
function placeText(model: Model, value: string, caret: number, focus: boolean): Step {
  return {
    model: { ...model, value, caret },
    commands: [Commands.PlaceCaret({ domId: model.instance?.domId ?? "composer", caret, focus })],
  }
}

function step(model: Model, message: Message, ctx: Context): Step {
  const domId = model.instance?.domId ?? "composer"
  const view = composerViewOf(ctx)
  const menus = menusOf(model, ctx, view.selectedProvider)
  return Message.match<Step>(message, {
    // Only the new-chat composer gets an eager entry. An existing chat is
    // left without one until the user changes something, so its state keeps
    // deriving from what the server says it last ran with (the seed) rather
    // than being pinned to whatever the defaults were at mount.
    CompletedMountTextarea: () => ({
      model,
      actions: view.composerChatId === ChatPreferences.NEW_CHAT_COMPOSER_ID
        ? [preferencesAction(ChatPreferences.Message.InitializedComposerForChat({ chatId: view.composerChatId, sourceState: null }))]
        : [],
    }),
    ChangedInput: ({ value, caret }) => ({ model: { ...model, value, caret } }),
    MovedCaret: ({ caret }) => ({ model: caret === model.caret ? model : { ...model, caret } }),
    Pasted: ({ files, text }) => {
      const enqueued = files.length > 0 ? enqueueFiles(model, files, ctx) : { model }
      if (!text) return enqueued
      return withCommands({ ...enqueued, model: { ...enqueued.model, value: text.value } }, [Commands.PlaceCaret({ domId, caret: text.caret, focus: false })])
    },
    PressedEnter: ({ withModifier }) => submit(model, ctx, withModifier),
    PressedTab: () => ({ model, commands: [Commands.FocusNextChatInput({ domId })] }),
    // Cycles the provider's modes in picker order: two for codex
    // (Full Access → Plan Mode), three for claude (… → Auto Plan).
    PressedShiftTab: () => {
      const modeControl = view.optionControls.mode
      if (!modeControl) return { model }
      const index = modeControl.options.indexOf(modeControl.selected)
      const next = modeControl.options[(index + 1) % modeControl.options.length]
      return next ? { model, actions: [preferencesAction(ChatPreferences.Message.ChangedChatComposerMode({ chatId: view.composerChatId, mode: next }))] } : { model }
    },
    RecalledPreviousPrompt: () => (ctx.props.previousPrompt ? { model: { ...model, value: ctx.props.previousPrompt } } : { model }),
    PressedEscapeToStop: () => {
      if (!ctx.props.canCancel || model.hold.phase === "holding" || model.hold.phase === "confirmed") return { model }
      // A press while the ring is still on its way back takes it from there.
      const resume = model.hold.phase === "released" && model.hold.ringShown
      return { model: { ...model, hold: { phase: "holding", ringShown: true, version: model.hold.version + 1, resume } } }
    },

    MovedSkillSelection: ({ towardWorse }) => ({
      model: { ...model, skillMenuOffset: towardWorse ? Math.min(model.skillMenuOffset + 1, menus.skillItems.length - 1) : Math.max(model.skillMenuOffset - 1, 0) },
    }),
    AcceptedSkill: ({ index }) => {
      const skill = menus.skillItems[index]
      if (!skill || !menus.skillMention) return { model }
      const completed = applySkillCompletion(model.value, menus.skillMention, skill.name)
      return placeText(model, completed.value, completed.caret, true)
    },
    HoveredSkill: ({ index }) => ({ model: { ...model, skillMenuOffset: menus.skillItems.length - 1 - index } }),
    DismissedSkillMenu: () => ({ model: { ...model, skillMenuDismissed: true } }),
    SucceededListSkills: ({ provider, skills }) => ({
      model: {
        ...model,
        skills: model.skillsFetch.provider === provider ? skills : model.skills,
        skillsFetch: { ...model.skillsFetch, pending: false },
      },
    }),
    FailedListSkills: () => ({ model: { ...model, skills: model.skills ?? [], skillsFetch: { ...model.skillsFetch, pending: false } } }),
    MovedProjectSelection: ({ towardWorse }) => ({
      model: { ...model, projectMenuOffset: towardWorse ? Math.min(model.projectMenuOffset + 1, menus.projectItems.length - 1) : Math.max(model.projectMenuOffset - 1, 0) },
    }),
    AcceptedProject: ({ index }) => {
      const project = menus.projectItems[index]
      const mention = getActiveProjectMention(model.value, model.caret)
      if (!project || !mention) return { model }
      const next = applyProjectMention(model.value, mention, project.localPath)
      return placeText(model, next.value, next.caret, true)
    },
    HoveredProject: ({ index }) => ({ model: { ...model, projectMenuOffset: menus.projectItems.length - 1 - index } }),
    DismissedProjectMenu: () => ({ model: { ...model, projectMenuDismissed: true } }),

    PressedPrimaryAction: ({ withModifier }) => runPrimaryAction(model, ctx, withModifier),
    PressedMic: () => {
      if (model.recording) return { model, commands: [Commands.FinishRecording({ key: domId })] }
      if (model.transcribing) return { model }
      return { model: { ...model, recorderError: null }, commands: [Commands.StartRecording({ key: domId })] }
    },
    PressedDiscardRecording: () => ({
      model: { ...model, recording: false },
      commands: [Commands.CancelRecording({ key: domId }), Commands.RefocusAfterDiscard({ domId })],
    }),
    StartedRecording: () => ({ model: { ...model, recording: true } }),
    FailedStartRecording: ({ error }) => ({ model: { ...model, recording: false, recorderError: error } }),
    FinishedRecording: ({ recording, error }) => {
      const next = { ...model, recording: false, recorderError: error ?? model.recorderError }
      if (!recording || model.transcribing) return { model: next }
      return { model: { ...next, transcribing: true }, commands: [Commands.Transcribe({ recording })] }
    },
    TranscribedRecording: ({ text }) => {
      if (!text) return { model: { ...model, transcribing: false, recorderError: "Didn't catch that. Try recording again." } }
      // React's spinner stayed for the send's round trip too (`await
      // onSubmit`); the session doesn't report back here yet, so it stops
      // as the send goes.
      return {
        model: { ...model, transcribing: false, pendingSubmit: { kind: "voice", value: text, attachments: [], uploadError: null } },
        actions: [AppAction.Chat({ message: ChatSession.Message.SubmittedMessage({ content: text, options: buildSubmitOptions(model, ctx, [], false) }) })],
      }
    },
    FailedTranscribe: ({ error }) => ({ model: { ...model, transcribing: false, recorderError: error } }),

    ConfirmedHold: ({ version }) => {
      if (version !== model.hold.version || model.hold.phase !== "holding") return { model }
      return {
        model: { ...model, hold: { ...model.hold, phase: "confirmed" } },
        commands: [Commands.DelayHoldStep({ version, step: "confirmed", ms: Commands.CONFIRMED_LINGER_MS })],
        actions: [AppAction.Chat({ message: ChatSession.Message.ClickedCancel() })],
      }
    },
    ReleasedHold: ({ version }) => {
      if (version !== model.hold.version || model.hold.phase !== "holding") return { model }
      return {
        model: { ...model, hold: { ...model.hold, phase: "released" } },
        commands: [Commands.DelayHoldStep({ version, step: "ring", ms: Commands.RELEASE_MS })],
      }
    },
    ElapsedHoldTimer: ({ version, step: timer }) => {
      if (version !== model.hold.version) return { model }
      if (timer === "ring") {
        return {
          model: { ...model, hold: { ...model.hold, ringShown: false } },
          commands: [Commands.DelayHoldStep({ version, step: "hint", ms: Commands.HINT_LINGER_MS - Commands.RELEASE_MS })],
        }
      }
      if (timer === "hint") {
        return { model: model.hold.phase === "released" ? { ...model, hold: { ...model.hold, phase: "idle" } } : model }
      }
      // A closed ring that the turn did not answer goes back like a release.
      if (model.hold.phase !== "confirmed") return { model }
      return {
        model: { ...model, hold: { ...model.hold, phase: "idle", ringShown: false } },
        commands: [Commands.EmptyRing({ domId, instant: false })],
      }
    },

    // OnFileChange has emptied the input already (`event.target.value = ""`).
    PickedFiles: ({ files }) => (files.length > 0 ? enqueueFiles(model, files, ctx) : { model }),
    StartedUpload: ({ tempId, file, previewUrl, generation }) => {
      if (generation !== model.uploadGeneration || !ctx.props.projectId) {
        return { model, commands: previewUrl ? [Commands.RevokePreviews({ urls: [previewUrl] })] : [] }
      }
      const attachment: ComposerAttachment = {
        id: tempId,
        kind: file.type.startsWith("image/") ? "image" : "file",
        displayName: file.name,
        absolutePath: "",
        relativePath: "",
        contentUrl: "",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "uploading",
        ...(previewUrl ? { previewUrl } : {}),
      }
      return {
        model: { ...model, attachments: [...model.attachments, attachment] },
        commands: [Commands.Upload({ tempId, file, projectId: ctx.props.projectId, generation })],
      }
    },
    SucceededUpload: ({ tempId, attachment: uploaded, generation }) => {
      const staged = model.attachments.find((attachment) => attachment.id === tempId)
      const previewUrl = staged?.previewUrl
      if (generation !== model.uploadGeneration) {
        return uploadSettled(model, ctx, {
          model,
          commands: [Commands.DeleteUploaded({ contentUrl: uploaded.contentUrl }), ...(previewUrl ? [Commands.RevokePreviews({ urls: [previewUrl] })] : [])],
        })
      }
      if (model.removedAttachmentIds.includes(tempId)) {
        return uploadSettled(model, ctx, {
          model: { ...model, removedAttachmentIds: model.removedAttachmentIds.filter((id) => id !== tempId) },
          commands: [...(previewUrl ? [Commands.RevokePreviews({ urls: [previewUrl] })] : []), Commands.DeleteUploaded({ contentUrl: uploaded.contentUrl })],
        })
      }
      return uploadSettled(model, ctx, {
        model: {
          ...model,
          attachments: model.attachments.map((attachment) => (
            attachment.id !== tempId ? attachment : { ...attachment, ...uploaded, previewUrl: attachment.previewUrl, status: "uploaded" as const }
          )),
          uploadError: null,
        },
      })
    },
    FailedUpload: ({ tempId, report, generation }) => {
      if (generation !== model.uploadGeneration) {
        const previewUrl = model.attachments.find((attachment) => attachment.id === tempId)?.previewUrl
        return uploadSettled(model, ctx, { model, commands: previewUrl ? [Commands.RevokePreviews({ urls: [previewUrl] })] : [] })
      }
      return uploadSettled(model, ctx, {
        model: {
          ...model,
          attachments: model.attachments.map((attachment) => (attachment.id === tempId ? { ...attachment, status: "failed" as const } : attachment)),
          uploadError: report,
        },
      })
    },
    ClickedAttachment: ({ id }) => {
      const attachment = model.attachments.find((candidate) => candidate.id === id)
      if (!attachment || attachment.status !== "uploaded") return { model }
      const target = classifyAttachmentPreview(attachment)
      if (target.openInNewTab) return { model, commands: [Commands.OpenInNewTab({ url: attachment.contentUrl })] }
      return {
        model,
        actions: [store(Stores.Message.GotViewerMessage({
          message: Viewer.Message.OpenedItem({ item: { kind: "attachment", attachment: Viewer.viewerAttachmentFromChat(attachment) }, expanded: false, byKey: false }),
        }))],
      }
    },
    ClickedRemoveAttachment: ({ id }) => {
      const removed = model.attachments.find((attachment) => attachment.id === id)
      if (!removed) return { model }
      const commands: AnyCommand[] = removed.previewUrl ? [Commands.RevokePreviews({ urls: [removed.previewUrl] })] : []
      const actions: AppAction[] = []
      // Removed while it's open in the viewer: its URL is about to go away.
      const viewing = Viewer.chatViewer({ viewer: ctx.stores.viewer, rightSidebar: ctx.stores.rightSidebar })?.item
      if (viewing?.kind === "attachment" && viewing.attachment.url === removed.contentUrl) {
        actions.push(store(Stores.Message.GotViewerMessage({ message: Viewer.Message.ClosedViewer({ byKey: false }) })))
      }
      let removedIds = [...model.removedAttachmentIds, id]
      if (removed.status === "uploaded") {
        removedIds = removedIds.filter((candidate) => candidate !== id)
        commands.push(Commands.DeleteUploaded({ contentUrl: removed.contentUrl }))
      }
      return {
        model: { ...model, removedAttachmentIds: removedIds, attachments: model.attachments.filter((attachment) => attachment.id !== id) },
        commands,
        actions,
      }
    },
    ClickedCopyUploadError: () => (model.uploadError ? { model, commands: [Commands.CopyUploadError({ detail: model.uploadError.detail })] } : { model }),
    CopiedUploadError: ({ copied }) => {
      if (!copied) return { model }
      const version = model.copiedVersion + 1
      return { model: { ...model, uploadErrorCopied: true, copiedVersion: version }, commands: [Commands.DelayCopied({ version })] }
    },
    ElapsedCopied: ({ version }) => ({ model: version === model.copiedVersion ? { ...model, uploadErrorCopied: false } : model }),

    GotPopoverMessage: ({ name, message: child }) => foldPopover(model, name, Popover.update(model.popovers[name], child)),
    GotTooltipMessage: ({ name, message: child }) => {
      const result = Tooltip.update(model.tooltips[name], child)
      return {
        model: { ...model, tooltips: { ...model.tooltips, [name]: result.model } },
        commands: Command.mapMessages(result.commands ?? [], (message: Tooltip.Message) => Message.GotTooltipMessage({ name, message })),
      }
    },
    PickedAccount: ({ accountId }) => closePopover({ ...model, accountChoices: { ...model.accountChoices, [view.selectedProvider]: accountId } }, "account"),
    PickedProvider: ({ provider }) => {
      const closed = closePopover(model, "provider")
      // Switching to a harness that isn't signed in is blocked: the pick is
      // stashed, a sign-in dialog opens, and the switch applies once the
      // auth store reports the service signed in.
      if (provider !== view.selectedProvider && ProviderAuth.unauthenticatedHarnesses(ctx.stores.providerAuth).has(provider)) {
        const opened = openSignInDialog(closed.model.signIn, provider, ctx.stores.providerAuth)
        return withCommands(
          { ...closed, model: { ...closed.model, pendingSignInProvider: provider, signIn: opened.model } },
          Command.mapMessages(opened.commands ?? [], (message: SignInDialogMessage) => Message.GotSignInMessage({ message })),
        )
      }
      return withCommands(closed, [], selectProviderActions(ctx, provider))
    },
    PickedModel: ({ model: modelId }) => {
      const closed = closePopover(model, "model")
      if (!isModelSelectable(view, modelId)) return closed
      // Write the full effective state with the model applied: the stored
      // state may still be for another provider.
      return withCommands(closed, [], [
        setComposerState(ctx, (state) => applyModelToComposerState(state, modelId, view.providerConfig)),
      ])
    },
    ChangedModelQuery: ({ query }) => ({ model: { ...model, modelQuery: query } }),
    // Opens the Default Models dialog, which is the chat page's (see the report).
    ClickedEditModels: () => closePopover(model, "model"),
    PickedReasoningEffort: ({ effort }) => {
      const closed = closePopover(model, "reasoning")
      const option = view.optionControls.reasoning?.options.find((candidate) => candidate.id === effort)
      if (!option || option.disabled) return closed
      return withCommands(closed, [], [
        setComposerState(ctx, (state) => ({ ...state, modelOptions: { ...state.modelOptions, reasoningEffort: effort } } as ComposerState)),
      ])
    },
    PickedContextWindow: ({ contextWindow }) => {
      const closed = closePopover(model, "contextWindow")
      if (!view.optionControls.contextWindow?.options.some((candidate) => candidate.id === contextWindow)) return closed
      return withCommands(closed, [], [
        setComposerState(ctx, (state) => state.provider !== "claude"
          ? state
          // Re-run model normalization so an invalid window for the model snaps back.
          : applyModelToComposerState({ ...state, modelOptions: { ...state.modelOptions, contextWindow: contextWindow as ClaudeContextWindow } }, state.model)),
      ])
    },
    PickedFastMode: ({ fastMode }) => {
      const closed = closePopover(model, "fastMode")
      if (!view.optionControls.fastMode) return closed
      return withCommands(closed, [], [
        setComposerState(ctx, (state) => ({ ...state, modelOptions: { ...state.modelOptions, fastMode } } as ComposerState)),
      ])
    },
    PickedMode: ({ mode }) => withCommands(closePopover(model, "mode"), [], modeActions(ctx, mode)),
    PickedDelegator: ({ chatId }) => {
      const closed = closePopover(model, "delegate")
      const projectId = ctx.props.projectId
      if (!projectId) return closed
      // Turning it off keeps which one was last used, for turning it back on.
      const preference = chatId ? { on: true, chatId } : { on: false, chatId: ctx.stores.delegate.projects[projectId]?.chatId }
      return withCommands(closed, [], [store(Stores.Message.GotDelegateMessage({ message: Delegate.Message.ChangedPreference({ projectId, preference }) }))])
    },
    // createDelegator: a delegator is kept and come back to, so it is named
    // for what it looks after, here, before it exists.
    ClickedNewDelegator: () => {
      const closed = closePopover(model, "delegate")
      const projectId = ctx.props.projectId
      if (!projectId) return closed
      return openAppDialog(closed, AppDialog.prompt({
        requestId: `${CREATE_DELEGATOR_REQUEST}${projectId}`,
        title: "New Delegator",
        description: "A chat that hands work to the chats under it instead of doing it. Name it for what it looks after.",
        placeholder: "Name (optional)",
        allowEmpty: true,
        confirmLabel: "Create",
      }))
    },
    GotAppDialogMessage: ({ message: child }) => {
      const result = AppDialog.update(model.appDialog, child)
      const stepped: Step = {
        model: { ...model, appDialog: result.model },
        commands: Command.mapMessages(result.commands ?? [], (message: AppDialog.Message) => Message.GotAppDialogMessage({ message })),
      }
      const answered = result.outMessage
      if (!answered || !answered.requestId.startsWith(CREATE_DELEGATOR_REQUEST) || answered.answer._tag !== "Prompt") return stepped
      const answer = answered.answer
      if (Option.isNone(answer.value)) return stepped
      const projectId = answered.requestId.slice(CREATE_DELEGATOR_REQUEST.length)
      return withCommands(stepped, [Commands.CreateDelegator({ projectId, name: answer.value.value })])
    },
    // Picked as what the project's new chat page delegates to.
    SucceededCreateDelegator: ({ projectId, chatId }) => ({
      model,
      actions: [store(Stores.Message.GotDelegateMessage({ message: Delegate.Message.ChangedPreference({ projectId, preference: { on: true, chatId } }) }))],
    }),
    FailedCreateDelegator: ({ error }) => openAppDialog({ model }, AppDialog.alert({
      requestId: "create-delegator-failed",
      title: "Could not create the delegator",
      description: error,
      closeLabel: "OK",
    })),
    GotSignInMessage: ({ message: child }) => {
      const result = updateSignInDialog(model.signIn, child)
      const commands = Command.mapMessages(result.commands ?? [], (message: SignInDialogMessage) => Message.GotSignInMessage({ message }))
      // Dismissed: the pick is dropped (onOpenChange(false)).
      const closed = result.outMessage?._tag === "Closed"
      return { model: { ...model, signIn: result.model, pendingSignInProvider: closed ? null : model.pendingSignInProvider }, commands }
    },
    ChangedStandalone: ({ matches }) => ({ model: model.isStandalone === matches ? model : { ...model, isStandalone: matches } }),
    IgnoredKey: () => ({ model }),
    ObservedApp: () => ({ model }),
    CompletedMountWaveform: () => ({ model }),
    CompletedMountComposer: () => ({ model }),

    ClearedDraftAfterSend: ({ draftId }) => ({
      // Text typed since the send is a new draft, already saved: it stays.
      model: { ...model, writtenDraft: model.value === "" ? null : model.writtenDraft },
      actions: [
        ...(model.value === "" ? [chatInputAction(ChatInput.Message.ClearedDraft({ chatId: draftId }))] : []),
        ...(uploadedAttachments(model).length === 0 ? [chatInputAction(ChatInput.Message.ClearedAttachmentDrafts({ chatId: draftId }))] : []),
      ],
      draftHandled: true,
    }),
    SucceededSend: () => {
      const pending = model.pendingSubmit
      if (!pending) return { model }
      const urls = previewUrls(pending.attachments)
      return {
        model: { ...model, pendingSubmit: null, transcribing: pending.kind === "voice" ? false : model.transcribing },
        commands: urls.length > 0 ? [Commands.RevokePreviews({ urls })] : [],
      }
    },
    FailedSend: ({ error }) => {
      const pending = model.pendingSubmit
      if (!pending) return { model }
      if (pending.kind === "voice") return { model: { ...model, pendingSubmit: null, transcribing: false, recorderError: error } }
      return {
        model: { ...model, pendingSubmit: null, value: pending.value, attachments: pending.attachments, uploadError: pending.uploadError },
      }
    },
    RequestedPrefill: ({ text }) => {
      // Text already there is kept, with the new text on a line of its own
      // after it: a draft is not something a click elsewhere should throw away.
      const existing = model.value.trimEnd()
      const next = existing ? `${existing}\n\n${text}` : text
      return placeText(model, next, next.length, true)
    },
    ReceivedFiles: ({ files }) => enqueueFiles(model, files, ctx),

    GotChatInputStoreMessage: ({ message: child }) => {
      if (child._tag === "ChangedDraft" && child.chatId === model.instance?.draftId) {
        // A write overtaken by a later keystroke, or by an outside clear,
        // stays unsent: the latest one carries the text.
        if (child.value !== model.value) return { model }
        return { model: { ...model, writtenDraft: child.value }, actions: [chatInputAction(child)] }
      }
      return { model, actions: [chatInputAction(child)] }
    },
    RequestedAction: ({ action }) => ({ model, actions: [action] }),
    CompletedSideEffect: () => ({ model }),
  })
}

export { accountsOf }
