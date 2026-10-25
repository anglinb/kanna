import { Option } from "effect"
import { Command, type Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { getIgnoreFolderEntryFromDiffPath, resolveDiffFilePath } from "../../client/app/ChatPage/utils"
import type { ChatBranchListEntry, DiffCommitMode } from "../../shared/types"
import { AppAction, batch } from "../app/action"
import { SliceOutMessage, type AppModel, type SliceReturn } from "../app/slice"
import * as Stores from "../app/stores"
import { chooseChatOpenMenuItem, openChatActions } from "../chat/chatReference"
import type { KannaSocketService } from "../core/socket"
import * as DiffCommit from "../core/stores/diffCommit"
import * as RightSidebar from "../core/stores/rightSidebar"
import * as ViewerStore from "../core/stores/viewer"
import * as AppDialog from "../ui/app-dialog"
import * as ContextMenu from "../ui/context-menu"
import * as Dialog from "../ui/dialog"
import * as Popover from "../ui/popover"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import {
  AwaitCardPaint,
  CheckoutBranch,
  CheckRepoAvailability,
  CommitDiffs,
  CopyText,
  CreateBranch,
  DiffFileAction,
  ExpireCopiedSha,
  ExpireRanQuickAction,
  ExposePort,
  FocusById,
  GenerateCommitMessage,
  GetPublishInfo,
  InitGit,
  KillPort,
  ListBranches,
  ListMergeBranches,
  ListPorts,
  MergeBranch,
  OpenInNewTab,
  PreviewMerge,
  PublishToGitHub,
  ReadBranch,
  ReadCommit,
  ReadDiffPatch,
  RefreshDiffs,
  RefreshUsage,
  ScrollIntoView,
  StopTask,
  SyncBranch,
  UnexposePort,
  WaitAvailabilityDelay,
  WaitPostRunRefresh,
  WriteQuickActions,
  AwaitPointerUp,
} from "./commands"
import { tooltipModel } from "./context"
import { commitEditorOpen as resolvedCommitEditorOpen, gitFacts, HOVER_LISTS, visibleFiles } from "./git"
import { mergeDisabled, mergeSelectedEntry, canPublish } from "./gitDialogs"
import {
  branchDetailsKey,
  branchPullRequestEntry,
  commitDetailsKey,
  diffHold,
  EMPTY_DIFF_SNAPSHOT,
  getDiffPreviewAttachment,
  INITIAL_VISIBLE_DIFF_FILE_COUNT,
  patchKey,
  pickerState,
  VISIBLE_DIFF_FILE_INCREMENT,
} from "./gitLogic"
import { applyHover, SyncHoverTracker, type HoverMessage } from "./hoverCard"
import { Message } from "./message"
import { init, initialPicker, type DialogContinuation, type MenuTarget, type Model, type Watch } from "./model"
import { isLoopbackHost } from "./ports"
import { scheduleEditPrompt } from "./schedules"
import { chatFacts, SCHEDULES_LIST } from "./view"
import { deriveSentAttachments } from "../../client/components/chat-ui/widgets/derive"

// What the column's Messages do: GitWidgets' and BranchPicker's handlers,
// the two modals', useChatPageSidebarActions' server calls with their
// alerts, the other widgets' own handlers, and the hover cards' reads.

type Return = SliceReturn<Model, Message>
type Cmd = Command.Command<Message, never, KannaSocketService>

const store = (message: Stores.Message) => AppAction.Store({ message })
const rightSidebar = (message: RightSidebar.Message) => store(Stores.Message.GotRightSidebarMessage({ message }))
const diffCommit = (message: DiffCommit.Message) => store(Stores.Message.GotDiffCommitMessage({ message }))
const viewer = (message: ViewerStore.Message) => store(Stores.Message.GotViewerMessage({ message }))

/** Several AppActions from one Message, as one OutMessage. */
function withActions(result: { model: Model; commands?: ReadonlyArray<Cmd> }, actions: ReadonlyArray<AppAction>): Return {
  if (actions.length === 0) return result as Return
  return {
    model: result.model,
    commands: result.commands ?? [],
    outMessage: SliceOutMessage.RequestedAppAction({ action: actions.length === 1 ? actions[0]! : batch(...actions) }),
  }
}

/** A card's `dismiss()`: down, and held down until the pointer leaves its row. */
const dismissCard = (list: string): Cmd =>
  Command.mapMessage(SyncHoverTracker({ list, action: "dismiss" }), (message: HoverMessage) => Message.GotHoverMessage({ message }))

// THE PAGE AS THE UPDATE SEES IT

interface Facts {
  watch: Watch
  projectId: string
  chatId: string | null
}

function pageOf(model: Model): Facts | null {
  return model.watch ? { watch: model.watch, projectId: model.watch.projectId, chatId: model.watch.chatId } : null
}

function diffsOf(app: AppModel, projectId: string) {
  return app.projectDiffs[projectId] ?? EMPTY_DIFF_SNAPSHOT
}

function draftOf(app: AppModel, projectId: string) {
  const ui = app.stores.rightSidebar.projectUi[projectId]
  return { summary: ui?.summary ?? "", description: ui?.description ?? "" }
}

function gitFactsOf(model: Model, app: AppModel, projectId: string) {
  return gitFacts({
    diffs: diffsOf(app, projectId),
    model,
    selection: app.stores.diffCommit.selectionsByProjectId[projectId],
    summary: draftOf(app, projectId).summary,
  })
}

function reviewedPathOf(app: AppModel, projectId: string) {
  return ViewerStore.reviewedPath({ viewer: app.stores.viewer, rightSidebar: app.stores.rightSidebar }, projectId)
}

/** useWidgetExpanded's current value, for a toggle. */
function storedExpanded(app: AppModel, projectId: string, id: RightSidebar.WidgetDisclosureId, rowCount: number, defaultOpen?: boolean) {
  const stored = app.stores.rightSidebar.projectUi[projectId]?.expanded?.[id]
  if (stored !== undefined) return stored
  return rowCount > 0 ? defaultOpen ?? (rowCount > 0 && rowCount <= 3) : false
}

const setExpanded = (projectId: string, id: RightSidebar.WidgetDisclosureId, expanded: boolean) =>
  rightSidebar(RightSidebar.Message.ChangedWidgetExpanded({ projectId, id, expanded }))

// CHILDREN

function menuStep(model: Model, step: Update.ReturnWithOutMessage<ContextMenu.Model, ContextMenu.Message, ContextMenu.OutMessage>) {
  return {
    model: modifyFields(model, { menu: () => step.model }),
    commands: (step.commands ?? []).map((command) => Command.mapMessage(command, (message: ContextMenu.Message) => Message.GotMenuMessage({ message }))) as unknown as Cmd[],
    outMessage: Option.fromNullishOr(step.outMessage),
  }
}

function tooltipStep(model: Model, id: string, message: Tooltip.Message): Return {
  const result = Tooltip.update(tooltipModel(model, id), message)
  return {
    model: modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [id]: result.model }) }),
    commands: Command.mapMessages(result.commands, (inner: Tooltip.Message) => Message.GotTooltipMessage({ id, message: inner })) as unknown as Cmd[],
  }
}

function dialogStep(step: Update.ReturnWithOutMessage<Dialog.Model, Dialog.Message, Dialog.OutMessage> | Update.Return<Dialog.Model, Dialog.Message>, wrap: (message: Dialog.Message) => Message) {
  return {
    dialog: step.model,
    commands: (step.commands ?? []).map((command) => Command.mapMessage(command, wrap)) as unknown as Cmd[],
    closed: "outMessage" in step && step.outMessage !== undefined && step.outMessage._tag === "Closed",
  }
}

const mergeDialogMessage = (message: Dialog.Message) => Message.GotMergeDialogMessage({ message })
const publishDialogMessage = (message: Dialog.Message) => Message.GotPublishDialogMessage({ message })

/** A request as the React call sites wrote it: `openDialog` adds the id. */
type DialogRequest = AppDialog.Request extends infer R ? (R extends AppDialog.Request ? Omit<R, "requestId"> : never) : never

/** Opens the column's app dialog; `then` runs when it is answered (React awaited the promise). */
function openDialog(model: Model, request: DialogRequest, then: DialogContinuation): Return {
  const requestId = `widgets-dialog-${model.dialogSeq + 1}`
  const opened = AppDialog.open(model.appDialog, { ...request, requestId } as AppDialog.Request)
  return {
    model: modifyFields(model, {
      appDialog: () => opened.model,
      dialogSeq: (seq) => seq + 1,
      pendingDialog: () => ({ requestId, then }),
    }),
    commands: Command.mapMessages(opened.commands, (message: AppDialog.Message) => Message.GotAppDialogMessage({ message })) as unknown as Cmd[],
  }
}

/** useAppDialog().alert, with nothing after it. */
function alert(model: Model, title: string, description: string): Return {
  return openDialog(model, { _tag: "Alert", title, description, closeLabel: "OK" }, { _tag: "None" })
}

/** A failed branch action's alert: its message and detail. */
function failureAlert(model: Model, result: { title: string; message: string; detail?: string }): Return {
  return alert(model, result.title, `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`)
}

const then = (first: Return, next: (model: Model) => Return): Return => {
  const second = next(first.model)
  return {
    model: second.model,
    commands: [...(first.commands ?? []), ...(second.commands ?? [])],
    ...(second.outMessage ? { outMessage: second.outMessage } : first.outMessage ? { outMessage: first.outMessage } : {}),
  }
}

// GIT

function setGit(model: Model, change: Partial<Model["git"]>): Model {
  return modifyFields(model, { git: (git) => ({ ...git, ...change }) })
}

function commit(model: Model, app: AppModel, facts: Facts, mode: DiffCommitMode, generated: { summary: string; description: string } | null): Return {
  const git = gitFactsOf(model, app, facts.projectId)
  const draft = draftOf(app, facts.projectId)
  return {
    model: setGit(model, { commitModeInFlight: mode, isGenerating: false, isGeneratedCommitInFlight: generated !== null }),
    commands: [CommitDiffs({
      projectId: facts.projectId,
      paths: git.selectedPaths,
      summary: generated?.summary ?? git.trimmedSummary,
      description: generated?.description ?? draft.description.trim(),
      mode,
    })],
  }
}

function generate(model: Model, app: AppModel, facts: Facts, thenCommit: DiffCommitMode | null): Return {
  const git = gitFactsOf(model, app, facts.projectId)
  if (!git.canGenerate) return { model }
  return { model: setGit(model, { isGenerating: true }), commands: [GenerateCommitMessage({ projectId: facts.projectId, paths: git.selectedPaths, thenCommit })] }
}

/** The commit button: commit what's written, else generate a message and commit with it. */
function primaryCommit(model: Model, app: AppModel, facts: Facts): Return {
  const git = gitFactsOf(model, app, facts.projectId)
  if (git.hasSummary) return git.canCommit ? commit(model, app, facts, git.primaryCommitMode, null) : { model }
  return generate(model, app, facts, git.primaryCommitMode)
}

function sync(model: Model, app: AppModel, facts: Facts, action: "fetch" | "pull" | "push" | "publish"): Return {
  if (diffsOf(app, facts.projectId).status !== "ready" || model.git.isSyncing || !facts.chatId) return { model }
  return { model: setGit(model, { isSyncing: true }), commands: [SyncBranch({ chatId: facts.chatId, action })] }
}

/** After an action that says the snapshot changed: read the diffs again (while the column is open). */
function refreshDiffs(facts: Facts): Cmd[] {
  return facts.chatId && facts.watch.active ? [RefreshDiffs({ chatId: facts.chatId })] : []
}

/** Keeps the file the viewer is on in sight: past the first five if it must be. */
function revealReviewed(model: Model, app: AppModel, facts: Facts): Return {
  const reviewed = facts.watch.reviewedPath
  if (!reviewed) return { model }
  const git = gitFactsOf(model, app, facts.projectId)
  const { matchingFiles } = { matchingFiles: visibleFiles({ model: setGit(model, { visibleFileCount: Number.MAX_SAFE_INTEGER }) }, git).matchingFiles }
  const index = matchingFiles.findIndex((file) => file.path === reviewed)
  if (index === -1) return { model }
  return {
    model: setGit(model, { visibleFileCount: Math.max(model.git.visibleFileCount, index + 1) }),
    commands: [ScrollIntoView({ id: null, list: HOVER_LISTS.changes, rowKey: reviewed })],
  }
}

function openReview(projectId: string, path: string): AppAction {
  return viewer(ViewerStore.Message.OpenedItem({ item: { kind: "diff", projectId, path }, expanded: false, byKey: false }))
}

// THE PICKER

function setPicker(model: Model, change: Partial<Model["git"]["picker"]>): Model {
  return setGit(model, { picker: { ...model.git.picker, ...change } })
}

function openPicker(model: Model, facts: Facts): Return {
  const token = model.git.picker.token + 1
  return {
    model: setGit(model, { branchesExpanded: true, picker: initialPicker(token) }),
    commands: [
      ...(facts.chatId ? [ListBranches({ chatId: facts.chatId, token })] : []),
      FocusById({ id: "widgets-branch-picker-search", finePointerOnly: true }),
    ],
  }
}

/** The picker's choice: check out (asking about changes first) or create. */
function choosePickerOption(model: Model, app: AppModel, facts: Facts, option: { kind: "branch"; entry: ChatBranchListEntry } | { kind: "create"; name: string; baseBranchName: string | null }): Return {
  if (model.git.picker.isMutating || !facts.chatId) return { model }
  const token = model.git.picker.token
  const mutating = setPicker(model, { isMutating: true })
  if (option.kind === "create") {
    return { model: mutating, commands: [CreateBranch({ chatId: facts.chatId, name: option.name, baseBranchName: option.baseBranchName, pickerToken: token })] }
  }
  if (diffsOf(app, facts.projectId).files.length > 0) {
    return openDialog(mutating, {
      _tag: "Confirm",
      title: "Bring Changes?",
      description: `You have uncommitted changes. Bring them to ${option.entry.name}?`,
      confirmLabel: "Bring Changes",
      cancelLabel: "Stay Here",
    }, { _tag: "CheckoutBranch", chatId: facts.chatId, branch: option.entry, pickerToken: token })
  }
  return { model: mutating, commands: [CheckoutBranch({ chatId: facts.chatId, branch: option.entry, bringChanges: false, pickerToken: token })] }
}

/** runMutation's finally, then onDone: the picker closes. */
function finishPickerMutation(model: Model, pickerToken: number): Model {
  if (model.git.picker.token !== pickerToken) return model
  return setGit(setPicker(model, { isMutating: false }), { branchesExpanded: false })
}

function pressPickerKey(model: Model, app: AppModel, facts: Facts, key: string): Return {
  const picker = model.git.picker
  const state = pickerState(picker, diffsOf(app, facts.projectId).branchName)
  if (key === "ArrowDown" || key === "ArrowUp") {
    const step = key === "ArrowDown" ? 1 : -1
    const options = state.options
    if (options.length === 0) return { model }
    const index = options.findIndex((option) => option.id === state.resolvedActiveId)
    const nextIndex = index === -1 ? (step === 1 ? 0 : options.length - 1) : (index + step + options.length) % options.length
    const next = options[nextIndex]!
    return {
      model: setPicker(model, { mode: "keyboard", keyboardActiveId: next.id }),
      commands: [ScrollIntoView({ id: next.id, list: null, rowKey: null })],
    }
  }
  if (key === "Enter") {
    const option = state.options.find((candidate) => candidate.id === state.resolvedActiveId)
    if (!option) return { model }
    return choosePickerOption(model, app, facts, option.kind === "branch"
      ? { kind: "branch", entry: option.entry }
      : { kind: "create", name: option.option.name, baseBranchName: option.option.baseBranchName ?? null })
  }
  if (key === "Escape") {
    // First Esc clears a search, the next closes the picker.
    if (picker.query) return { model: setPicker(model, { query: "", keyboardActiveId: null }) }
    return { model: setGit(model, { branchesExpanded: false }) }
  }
  return { model }
}

// HOVER CARDS: their reads

function readBranchDetails(model: Model, facts: Facts, entry: ChatBranchListEntry): Return {
  const key = branchDetailsKey(entry)
  if (key in model.branchDetails || model.branchReads.includes(key)) return { model }
  return {
    model: modifyFields(model, { branchReads: (reads) => [...reads, key] }),
    commands: [ReadBranch({ projectId: facts.projectId, key, entry })],
  }
}

/** A card came up on a row: read what it needs that isn't cached (useCardDetails). */
function readCardDetails(model: Model, app: AppModel, facts: Facts, list: string, key: string): Return {
  const diffs = diffsOf(app, facts.projectId)
  if (list === HOVER_LISTS.history) {
    const entry = diffs.branchHistory?.entries.find((candidate) => candidate.sha === key)
    if (!entry) return { model }
    const cacheKey = commitDetailsKey(entry)
    if (cacheKey in model.commitDetails || model.commitReads.includes(cacheKey)) return { model }
    return {
      model: modifyFields(model, { commitReads: (reads) => [...reads, cacheKey] }),
      commands: [ReadCommit({ projectId: facts.projectId, key: cacheKey, sha: entry.sha })],
    }
  }
  if (list === HOVER_LISTS.changes) {
    const file = diffs.files.find((candidate) => candidate.path === key)
    if (!file || getDiffPreviewAttachment(facts.projectId, file) || diffHold(file)) return { model }
    const cacheKey = patchKey(file)
    if (cacheKey in model.patches || model.patchReads.includes(cacheKey)) return { model }
    return {
      model: modifyFields(model, { patchReads: (reads) => [...reads, cacheKey] }),
      commands: [ReadDiffPatch({ projectId: facts.projectId, key: cacheKey, path: file.path })],
    }
  }
  if (list === HOVER_LISTS.branchPullRequest && diffs.branchName && diffs.branchPullRequest) {
    return readBranchDetails(model, facts, branchPullRequestEntry(diffs.branchName, diffs.branchPullRequest))
  }
  if (list === HOVER_LISTS.picker) {
    const branchList = model.git.picker.branchList
    const entry = branchList ? [...branchList.recent, ...branchList.local, ...branchList.remote, ...branchList.pullRequests].find((candidate) => candidate.id === key) : undefined
    return entry ? readBranchDetails(model, facts, entry) : { model }
  }
  return { model }
}

/** Keeps a cache bounded (useCardDetails' limit), dropping the oldest. */
function bounded<T>(cache: Readonly<Record<string, T>>, key: string, value: T, limit: number): Record<string, T> {
  const keys = Object.keys(cache)
  const trimmed = keys.length >= limit ? Object.fromEntries(Object.entries(cache).slice(keys.length - limit + 1)) : { ...cache }
  return { ...trimmed, [key]: value }
}

// THE ROW MENU

function chooseMenuItem(model: Model, app: AppModel, facts: Facts, target: MenuTarget, value: string): Return {
  switch (target._tag) {
    case "DiffFile": {
      const path = target.path
      const projectPath = app.chat?.snapshot?.runtime.localPath ?? null
      switch (value) {
        case "review": return withActions({ model }, [openReview(facts.projectId, path)])
        case "open-editor": return withActions({ model }, [AppAction.OpenLocalLink({ target: { path: resolveDiffFilePath(projectPath, path) }, action: "open_editor", editor: null })])
        case "open-finder": return withActions({ model }, [AppAction.OpenExternalPath({ action: "open_finder", localPath: path })])
        case "copy-path": return withActions({ model }, [AppAction.CopyPath({ localPath: resolveDiffFilePath(projectPath, path) })])
        case "copy-relative": return withActions({ model }, [AppAction.CopyPath({ localPath: path })])
        case "discard":
          return facts.chatId
            ? openDialog(model, { _tag: "Confirm", title: "Discard Changes", description: `Discard changes for "${path}"? This cannot be undone.`, confirmLabel: "Discard", confirmVariant: "destructive" }, { _tag: "DiscardFile", chatId: facts.chatId, path })
            : { model }
        case "ignore-file":
          return facts.chatId
            ? openDialog(model, { _tag: "Confirm", title: "Ignore File", description: `Add "${path}" to .gitignore?`, confirmLabel: "Ignore", confirmVariant: "destructive" }, { _tag: "IgnoreFile", chatId: facts.chatId })
            : { model }
        case "ignore-folder": {
          const initialValue = getIgnoreFolderEntryFromDiffPath(path)
          if (!facts.chatId || !initialValue) return { model }
          return openDialog(model, { _tag: "Prompt", title: "Ignore Folder", description: "Edit the folder pattern to add to .gitignore.", initialValue, confirmLabel: "Ignore" }, { _tag: "IgnoreFile", chatId: facts.chatId })
        }
        default: return { model }
      }
    }
    case "Task": {
      const task = chatFacts(app, facts.chatId).subagents.find((candidate) => candidate.id === target.taskId)
      if (!task) return { model }
      if (value === "stop") return stopTask(model, app, facts, task.id)
      if (value === "show-in-chat") {
        const toolId = chatFacts(app, facts.chatId).toolIds.get(task.id)
        return toolId ? jumpToToolCall(model, facts, toolId) : { model }
      }
      if (task.chatId) {
        const actions = chooseChatOpenMenuItem(value, app, task.chatId)
        return actions ? withActions({ model }, actions) : { model }
      }
      return { model }
    }
    case "Schedule":
      return editSchedule(model, app, facts, target.scheduleId)
    case "Port": {
      const server = model.ports.servers.find((candidate) => candidate.port === target.port)
      if (!server) return { model }
      switch (value) {
        case "open": return openServer(model, app, server.port)
        case "copy-public": return { model, commands: [CopyText({ text: server.publicUrl ?? "" })] }
        case "unexpose":
          return {
            model: modifyFields(model, { ports: (ports) => ({ ...ports, servers: ports.servers.map((candidate) => (candidate.port === server.port ? withoutPublicUrl(candidate) : candidate)) }) }),
            commands: [UnexposePort({ port: server.port })],
          }
        case "expose": return exposeServer(model, app, server.port)
        case "kill":
          return {
            model: modifyFields(model, { ports: (ports) => ({ ...ports, servers: ports.servers.filter((candidate) => candidate.port !== server.port) }) }),
            commands: [KillPort({ port: server.port })],
          }
        default: return { model }
      }
    }
    case "QuickAction": {
      if (value !== "delete") return { model }
      return writeQuickActions(model, facts.projectId, currentQuickActions(model, app, facts).filter((candidate) => candidate.id !== target.id))
    }
  }
}

// TASKS

function stopTask(model: Model, app: AppModel, facts: Facts, taskId: string): Return {
  if (!facts.chatId) return { model }
  // Ids whose task has ended since leave the set (useStopTask's effect on the tasks).
  const running = new Set(chatFacts(app, facts.chatId).subagents.filter((task) => task.status === "running").map((task) => task.id))
  return {
    model: modifyFields(model, { stopError: () => null, stopping: (stopping) => [...stopping.filter((id) => running.has(id) && id !== taskId), taskId] }),
    commands: [StopTask({ chatId: facts.chatId, taskId })],
  }
}

function jumpToToolCall(model: Model, facts: Facts, toolId: string): Return {
  if (!facts.chatId) return { model }
  return withActions({ model }, [
    AppAction.OpenChatAt({ chatId: facts.chatId, jump: { toolId } }),
    // On a phone the column is a sheet over the chat: close it so the jump lands somewhere visible.
    ...(facts.watch.isMobile ? [rightSidebar(RightSidebar.Message.HidWidgets({ projectId: facts.projectId, chatKey: facts.watch.widgetsChatKey }))] : []),
  ])
}

/** Edit starts the sentence that changes the schedule in the composer. */
function editSchedule(model: Model, app: AppModel, facts: Facts, scheduleId: string): Return {
  const schedule = chatFacts(app, facts.chatId).schedules.find((candidate) => candidate.id === scheduleId)
  if (!schedule || !facts.chatId) return { model }
  return withActions({ model }, [AppAction.PrefillComposer({ text: scheduleEditPrompt(schedule) })])
}

// PORTS

function withoutPublicUrl<T extends { publicUrl?: string }>(server: T): T {
  const { publicUrl: _removed, ...rest } = server
  return rest as T
}

function readPorts(model: Model, facts: Facts): Return {
  if (model.ports.reading) return { model }
  return { model: modifyFields(model, { ports: (ports) => ({ ...ports, reading: true }) }), commands: [ListPorts({ projectId: facts.projectId })] }
}

function exposeServer(model: Model, app: AppModel, port: number): Return {
  if (app.stores.serverCapabilities.value?.publicSharing !== true) return { model }
  const server = model.ports.servers.find((candidate) => candidate.port === port)
  if (!server || server.publicUrl) return { model }
  return {
    model: modifyFields(model, { ports: (ports) => ({ ...ports, exposingPorts: ports.exposingPorts.includes(port) ? ports.exposingPorts : [...ports.exposingPorts, port] }) }),
    commands: [ExposePort({ port })],
  }
}

/** A row's open: on this machine its address; elsewhere its tunnel, exposing first when there is none. */
function openServer(model: Model, app: AppModel, port: number): Return {
  const server = model.ports.servers.find((candidate) => candidate.port === port)
  if (!server) return { model }
  const viewerIsLocal = typeof window !== "undefined" && isLoopbackHost(window.location.hostname)
  const url = viewerIsLocal ? server.address : server.publicUrl
  if (url) return { model, commands: [OpenInNewTab({ url })] }
  return exposeServer(model, app, port)
}

// QUICK ACTIONS

function writeQuickActions(model: Model, projectId: string, actions: ReadonlyArray<import("../../shared/protocol").ProjectQuickAction>): Return {
  return {
    model: modifyFields(model, { quickActions: (state) => ({ ...state, written: { projectId, actions } }) }),
    commands: [WriteQuickActions({ projectId, actions })],
  }
}

// OBSERVING THE PAGE

function observePage(model: Model, app: AppModel, watch: Watch, paths: ReadonlyArray<string>): Return {
  const previous = model.watch
  const projectChanged = previous === null || previous.projectId !== watch.projectId
  let next: Model = model
  if (projectChanged && previous !== null) {
    // The column remounts with the project (ChatWorkspace's key): its state
    // starts over, what React held in module caches stays.
    const fresh = init()
    next = {
      ...fresh,
      branchDetails: model.branchDetails,
      commitDetails: model.commitDetails,
      patches: model.patches,
      ports: { ...fresh.ports, servers: model.ports.servers, loaded: model.ports.loaded },
      git: { ...fresh.git, picker: initialPicker(model.git.picker.token + 1) },
      now: model.now,
    }
  }
  if (next.git.commitEditorOpen === null) {
    // A draft already written starts the fields open; never focused on mount.
    const draft = draftOf(app, watch.projectId)
    next = setGit(next, { commitEditorOpen: draft.summary.trim().length > 0 || draft.description.trim().length > 0 })
  }
  if (previous !== null && previous.chatId !== watch.chatId) {
    // A new chat's tasks are its own; a stop pending on the last one isn't.
    next = modifyFields(next, { stopping: () => [], stopError: () => null })
  }
  next = modifyFields(next, { watch: () => watch, ...(previous?.clockMs !== watch.clockMs ? { now: () => Date.now() } : {}) })
  const actions: AppAction[] = []
  if (projectChanged || previous.filesKey !== watch.filesKey) {
    actions.push(diffCommit(DiffCommit.Message.ReconciledProject({ projectId: watch.projectId, paths: [...paths] })))
  }
  const facts = pageOf(next)!
  const revealed = projectChanged || previous.reviewedPath !== watch.reviewedPath || previous.filesKey !== watch.filesKey
    ? revealReviewed(next, app, facts)
    : { model: next }
  // PortsWidget's read at once as the column opens (its effect on `active`).
  const opened = watch.active && (projectChanged || !previous.active)
    ? then(revealed, (current) => readPorts(current, facts))
    : revealed
  return withActions(opened, actions)
}

// UPDATE

export function update(model: Model, message: Message, app: AppModel): Return {
  const facts = pageOf(model)
  const needFacts = (handle: (facts: Facts) => Return): Return => (facts ? handle(facts) : { model })

  return Message.match<Return>(message, {
    ObservedPage: ({ watch, paths }) => observePage(model, app, watch, paths),
    TickedClock: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),
    CompletedSideEffect: () => ({ model }),

    // PRIMITIVES

    PressedMenuTrigger: ({ target, pointerType, button, x, y }) => {
      const step = menuStep(model, ContextMenu.update(model.menu, ContextMenu.Message.PressedTrigger({ pointerType, button, x, y })))
      // A touch press opens on its own after the long-press delay: it names its target now.
      const next = pointerType === "touch" || pointerType === "pen" ? modifyFields(step.model, { menuTarget: () => target }) : step.model
      return { model: next, commands: step.commands }
    },
    RequestedMenu: ({ target }) => {
      const step = menuStep(modifyFields(model, { menuTarget: () => target }), ContextMenu.update(model.menu, ContextMenu.Message.RequestedContextMenu()))
      return { model: step.model, commands: step.commands }
    },
    MovedOnMenuTrigger: () => {
      if (Option.isNone(model.menu.longPressVersion)) return { model }
      const step = menuStep(model, ContextMenu.update(model.menu, ContextMenu.Message.CancelledLongPress()))
      return { model: step.model, commands: step.commands }
    },
    PressedRowKebab: ({ target, x, y }) => {
      const pressed = ContextMenu.update(model.menu, ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y }))
      const opened = ContextMenu.update(pressed.model, ContextMenu.Message.RequestedContextMenu())
      const step = menuStep(modifyFields(model, { menuTarget: () => target }), opened)
      return { model: step.model, commands: [...menuStep(model, pressed).commands, ...step.commands] }
    },
    GotMenuMessage: ({ message: child }) => {
      const step = menuStep(model, ContextMenu.update(model.menu, child))
      const out = step.outMessage
      if (Option.isSome(out) && out.value._tag === "Selected" && model.menuTarget && facts) {
        const chosen = chooseMenuItem(step.model, app, facts, model.menuTarget, out.value.value)
        return { ...chosen, commands: [...step.commands, ...(chosen.commands ?? [])] }
      }
      return { model: step.model, commands: step.commands }
    },
    GotCommitMenuMessage: ({ message: child }) => {
      const step = ContextMenu.update(model.commitMenu, child)
      const commands = (step.commands ?? []).map((command) => Command.mapMessage(command, (inner: ContextMenu.Message) => Message.GotCommitMenuMessage({ message: inner }))) as unknown as Cmd[]
      const next = modifyFields(model, { commitMenu: () => step.model })
      if (step.outMessage?._tag === "Selected" && facts) {
        const chosen = commitOnly(next, app, facts)
        return { ...chosen, commands: [...commands, ...(chosen.commands ?? [])] }
      }
      return { model: next, commands }
    },
    GotTooltipMessage: ({ id, message: child }) => tooltipStep(model, id, child),
    GotHoverMessage: ({ message: child }) => hover(model, app, facts, child),
    // Whatever happened since: the card was up, and its effect ran.
    ShowedCard: ({ list, key }) => (facts ? readCardDetails(model, app, facts, list, key) : { model }),
    GotPartsMessage: () => ({ model }),
    GotAppDialogMessage: ({ message: child }) => {
      const step = AppDialog.update(model.appDialog, child)
      const commands = Command.mapMessages(step.commands ?? [], (inner: AppDialog.Message) => Message.GotAppDialogMessage({ message: inner })) as unknown as Cmd[]
      const next = modifyFields(model, { appDialog: () => step.model })
      const out = step.outMessage
      if (!out || !model.pendingDialog || out.requestId !== model.pendingDialog.requestId) return { model: next, commands }
      const answered = answerDialog(modifyFields(next, { pendingDialog: () => null }), model.pendingDialog.then, out.answer)
      return { ...answered, commands: [...commands, ...(answered.commands ?? [])] }
    },
    ClickedOpenUrl: ({ url }) => ({ model, commands: [OpenInNewTab({ url })] }),
    ClickedCardUrl: ({ list, url }) => ({ model, commands: [dismissCard(list), OpenInNewTab({ url })] }),

    // GIT: THE BRANCH CARD

    ToggledBranches: () => needFacts((facts) => (model.git.branchesExpanded ? { model: setGit(model, { branchesExpanded: false }) } : openPicker(model, facts))),
    ClickedSync: ({ action }) => needFacts((facts) => sync(model, app, facts, action)),
    SucceededSync: ({ result }) => needFacts((facts) => {
      const next = setGit(model, { isSyncing: false })
      const refreshed = { model: next, commands: result.snapshotChanged ? refreshDiffs(facts) : [] }
      return result.ok ? refreshed : then(refreshed, (current) => failureAlert(current, result))
    }),
    FailedSync: ({ error }) => alert(setGit(model, { isSyncing: false }), "Git sync failed", error),
    ClickedPushToGitHub: () => needFacts((facts) => openPublish(model, facts)),
    ClickedMergeInto: () => needFacts((facts) => openMerge(model, facts)),
    ChangedCommitSummary: ({ value }) => needFacts((facts) => withActions({ model }, [
      rightSidebar(RightSidebar.Message.ChangedCommitDraft({ projectId: facts.projectId, summary: value, description: draftOf(app, facts.projectId).description })),
    ])),
    ChangedCommitDescription: ({ value }) => needFacts((facts) => withActions({ model }, [
      rightSidebar(RightSidebar.Message.ChangedCommitDraft({ projectId: facts.projectId, summary: draftOf(app, facts.projectId).summary, description: value })),
    ])),
    PressedCommitShortcut: () => needFacts((facts) => primaryCommit(model, app, facts)),
    ClickedGenerateMessage: () => needFacts((facts) => generate(model, app, facts, null)),
    ClickedCommit: () => needFacts((facts) => primaryCommit(model, app, facts)),
    ClickedCommitOnly: () => needFacts((facts) => commitOnly(model, app, facts)),
    ToggledCommitEditor: () => {
      const opening = !resolvedCommitEditorOpen({ model, summary: facts ? draftOf(app, facts.projectId).summary : "", description: facts ? draftOf(app, facts.projectId).description : "" } as never)
      return {
        model: setGit(model, { commitEditorOpen: opening }),
        // Focus only on a click, never on mount.
        commands: opening ? [FocusById({ id: "widgets-commit-message", finePointerOnly: false })] : [],
      }
    },
    SucceededGenerateMessage: ({ subject, body, thenCommit }) => needFacts((facts) => {
      const draft = withActions({ model: setGit(model, { isGenerating: false }) }, [
        rightSidebar(RightSidebar.Message.ChangedCommitDraft({ projectId: facts.projectId, summary: subject, description: body })),
      ])
      if (thenCommit === null || !subject.trim()) return draft
      const committed = commit(draft.model, app, facts, thenCommit, { summary: subject.trim(), description: body.trim() })
      return { ...draft, model: committed.model, commands: [...(draft.commands ?? []), ...(committed.commands ?? [])] }
    }),
    FailedGenerateMessage: () => ({ model: setGit(model, { isGenerating: false }) }),
    SucceededCommit: ({ result }) => needFacts((facts) => {
      const next = setGit(model, { commitModeInFlight: null, isGeneratedCommitInFlight: false, isGenerating: false })
      const commands = result.snapshotChanged ? refreshDiffs(facts) : []
      const cleared = result.ok || result.localCommitCreated
        ? withActions({ model: next, commands }, [rightSidebar(RightSidebar.Message.ClearedCommitDraft({ projectId: facts.projectId }))])
        : { model: next, commands }
      if (result.ok) return cleared
      const description = result.localCommitCreated
        ? `${result.message}\n\nA local commit was created, but the push did not complete.${result.detail ? `\n\n${result.detail}` : ""}`
        : `${result.message}${result.detail ? `\n\n${result.detail}` : ""}`
      return then(cleared, (current) => alert(current, result.title, description))
    }),
    FailedCommit: ({ error }) => alert(setGit(model, { commitModeInFlight: null, isGeneratedCommitInFlight: false, isGenerating: false }), "Commit failed", error),
    ChangedFileQuery: ({ value }) => needFacts((facts) => revealReviewed(setGit(model, { fileQuery: value }), app, facts)),
    ClearedFileQuery: () => needFacts((facts) => revealReviewed(setGit(model, { fileQuery: "" }), app, facts)),
    ClickedShowMoreFiles: () => ({ model: setGit(model, { visibleFileCount: model.git.visibleFileCount + VISIBLE_DIFF_FILE_INCREMENT }) }),
    ClickedShowFewerFiles: () => ({ model: setGit(model, { visibleFileCount: INITIAL_VISIBLE_DIFF_FILE_COUNT }) }),
    ToggledFile: ({ path }) => needFacts((facts) => {
      const checked = DiffCommit.isDiffPathChecked(app.stores.diffCommit.selectionsByProjectId[facts.projectId], path)
      return withActions({ model }, [diffCommit(DiffCommit.Message.ChangedPathChecked({ projectId: facts.projectId, path, checked: !checked }))])
    }),
    ToggledAllFiles: () => needFacts((facts) => {
      const git = gitFactsOf(model, app, facts.projectId)
      const paths = diffsOf(app, facts.projectId).files.map((file) => file.path)
      return withActions({ model }, [diffCommit(DiffCommit.Message.ChangedAllChecked({ projectId: facts.projectId, paths, checked: git.someSelected ? true : !git.allSelected }))])
    }),
    ClickedReviewFile: ({ path }) => needFacts((facts) => withActions({ model }, [openReview(facts.projectId, path)])),
    ClickedReviewChecked: () => needFacts((facts) => {
      // Opens on a checked file, so the review is the checked files and nothing else.
      const selection = app.stores.diffCommit.selectionsByProjectId[facts.projectId]
      const reviewed = reviewedPathOf(app, facts.projectId)
      const firstChecked = gitFactsOf(model, app, facts.projectId).filesInOrder.find((file) => DiffCommit.isDiffPathChecked(selection, file.path))?.path ?? null
      const target = reviewed !== null && DiffCommit.isDiffPathChecked(selection, reviewed) ? reviewed : firstChecked
      return target ? withActions({ model }, [openReview(facts.projectId, target)]) : { model }
    }),
    ToggledHistory: () => needFacts((facts) => {
      const count = diffsOf(app, facts.projectId).branchHistory?.entries.length ?? 0
      return withActions({ model }, [setExpanded(facts.projectId, "history", !storedExpanded(app, facts.projectId, "history", count, true))])
    }),
    ClickedShowAllHistory: ({ shown }) => ({ model: setGit(model, { showAllHistory: shown }) }),
    ClickedPullIncoming: () => needFacts((facts) => sync(model, app, facts, "pull")),
    ClickedInitGit: () => needFacts((facts) => (facts.chatId ? { model, commands: [InitGit({ chatId: facts.chatId })] } : { model })),
    SucceededInitGit: ({ result }) => needFacts((facts) => {
      const refreshed = { model, commands: result.snapshotChanged && facts.chatId ? [RefreshDiffs({ chatId: facts.chatId })] : [] }
      return result.ok ? refreshed : then(refreshed, (current) => failureAlert(current, result))
    }),
    FailedInitGit: ({ error }) => alert(model, "Initialize git failed", error),
    ClickedCopySha: ({ sha }) => {
      const token = model.copiedToken + 1
      return { model: modifyFields(model, { copiedSha: () => sha, copiedToken: () => token }), commands: [CopyText({ text: sha }), ExpireCopiedSha({ token })] }
    },
    ExpiredCopiedSha: ({ token }) => ({ model: token === model.copiedToken ? modifyFields(model, { copiedSha: () => null }) : model }),

    // GIT: THE BRANCH PICKER

    SucceededListBranches: ({ token, result }) => ({
      model: token === model.git.picker.token ? setPicker(model, { branchList: result, isLoading: false }) : model,
    }),
    FailedListBranches: ({ token, error }) => ({ model: token === model.git.picker.token ? setPicker(model, { error, isLoading: false }) : model }),
    // The cursor goes with the search (an effect on the query in React).
    ChangedPickerQuery: ({ value }) => ({ model: setPicker(model, { query: value, keyboardActiveId: null }) }),
    PressedPickerKey: ({ key }) => needFacts((facts) => pressPickerKey(model, app, facts, key)),
    MovedPointerOverPicker: () => ({ model: setPicker(model, { mode: "pointer", keyboardActiveId: null }) }),
    ToggledPickerSection: ({ section }) => ({
      model: setPicker(model, {
        collapsedSections: model.git.picker.collapsedSections.includes(section)
          ? model.git.picker.collapsedSections.filter((candidate) => candidate !== section)
          : [...model.git.picker.collapsedSections, section],
      }),
    }),
    ClickedPickerShowAll: ({ section, shown }) => ({
      model: setPicker(model, section === "local" ? { showAllLocal: shown } : section === "remote" ? { showAllRemote: shown } : { showAllPullRequests: shown }),
    }),
    ChoseBranch: ({ entry }) => needFacts((facts) => choosePickerOption(model, app, facts, { kind: "branch", entry })),
    ChoseCreateBranch: ({ name, baseBranchName }) => needFacts((facts) => choosePickerOption(model, app, facts, { kind: "create", name, baseBranchName })),
    SucceededCheckout: ({ pickerToken, result }) => needFacts((facts) => {
      const next = { model: finishPickerMutation(model, pickerToken), commands: result.snapshotChanged ? refreshDiffs(facts) : [] }
      return !result.ok && !result.cancelled ? then(next, (current) => failureAlert(current, result)) : next
    }),
    SucceededCreateBranch: ({ pickerToken, result }) => needFacts((facts) => {
      const next = { model: finishPickerMutation(model, pickerToken), commands: result.snapshotChanged ? refreshDiffs(facts) : [] }
      return result.ok ? next : then(next, (current) => failureAlert(current, result))
    }),
    FailedBranchMutation: ({ pickerToken, title, error }) => alert(finishPickerMutation(model, pickerToken), title, error),
    RequestedBranchDetails: ({ entry }) => needFacts((facts) => readBranchDetails(model, facts, entry)),
    SucceededReadBranch: ({ key, details }) => ({
      model: modifyFields(model, { branchDetails: (cache) => bounded(cache, key, details, 100), branchReads: (reads) => reads.filter((read) => read !== key) }),
    }),
    FailedReadBranch: ({ key }) => ({ model: modifyFields(model, { branchReads: (reads) => reads.filter((read) => read !== key) }) }),
    SucceededReadCommit: ({ key, details }) => ({
      model: modifyFields(model, { commitDetails: (cache) => bounded(cache, key, details, 100), commitReads: (reads) => reads.filter((read) => read !== key) }),
    }),
    FailedReadCommit: ({ key }) => ({ model: modifyFields(model, { commitReads: (reads) => reads.filter((read) => read !== key) }) }),
    SucceededReadPatch: ({ key, patch }) => ({
      model: modifyFields(model, { patches: (cache) => bounded(cache, key, patch, 50), patchReads: (reads) => reads.filter((read) => read !== key) }),
    }),
    FailedReadPatch: ({ key }) => ({ model: modifyFields(model, { patchReads: (reads) => reads.filter((read) => read !== key) }) }),

    // GIT: MERGE DIALOG

    GotMergeDialogMessage: ({ message: child }) => {
      const step = dialogStep(Dialog.update(model.merge.dialog, child), mergeDialogMessage)
      const next = modifyFields(model, { merge: (merge) => ({ ...merge, dialog: step.dialog }) })
      return { model: step.closed ? resetMerge(next) : next, commands: step.commands }
    },
    SucceededMergeList: ({ token, result }) => ({ model: token === model.merge.token ? modifyFields(model, { merge: (merge) => ({ ...merge, branchList: result }) }) : model }),
    ChangedMergeQuery: ({ value }) => ({ model: modifyFields(model, { merge: (merge) => ({ ...merge, query: value }) }) }),
    SelectedMergeBranch: ({ name }) => needFacts((facts) => {
      const token = model.merge.token + 1
      const selected = modifyFields(model, { merge: (merge): Model["merge"] => ({ ...merge, selectedName: name, preview: null, previewError: null, isPreviewLoading: true, token }) })
      const entry = mergeSelectedEntry({ model: selected, diffs: diffsOf(app, facts.projectId) } as never)
      if (!entry) return { model: modifyFields(selected, { merge: (merge): Model["merge"] => ({ ...merge, isPreviewLoading: false }) }) }
      if (!facts.chatId) {
        return {
          model: modifyFields(selected, {
            merge: (merge): Model["merge"] => ({
              ...merge,
              isPreviewLoading: false,
              preview: { currentBranchName: undefined, targetBranchName: entry.name, targetDisplayName: entry.displayName, status: "error", commitCount: 0, hasConflicts: false, message: "Merge preview unavailable." },
            }),
          }),
        }
      }
      return { model: selected, commands: [PreviewMerge({ chatId: facts.chatId, branch: entry, token })] }
    }),
    SucceededMergePreview: ({ token, result }) => ({
      model: token === model.merge.token ? modifyFields(model, { merge: (merge) => ({ ...merge, preview: result, isPreviewLoading: false }) }) : model,
    }),
    FailedMergePreview: ({ token, error }) => ({
      model: token === model.merge.token ? modifyFields(model, { merge: (merge) => ({ ...merge, previewError: error, isPreviewLoading: false }) }) : model,
    }),
    ClickedMerge: () => needFacts((facts) => {
      const entry = mergeSelectedEntry({ model, diffs: diffsOf(app, facts.projectId) } as never)
      if (!entry || mergeDisabled({ model, diffs: diffsOf(app, facts.projectId) } as never) || !facts.chatId) return { model }
      return { model: modifyFields(model, { merge: (merge) => ({ ...merge, isMerging: true }) }), commands: [MergeBranch({ chatId: facts.chatId, branch: entry })] }
    }),
    ClickedMergeCancel: () => closeMerge(model),
    SucceededMerge: ({ result }) => needFacts((facts) => {
      const next = { model: modifyFields(model, { merge: (merge) => ({ ...merge, isMerging: false }) }), commands: result.snapshotChanged ? refreshDiffs(facts) : [] }
      if (result.ok) {
        const closed = closeMerge(next.model)
        return { model: closed.model, commands: [...next.commands, ...(closed.commands ?? [])] }
      }
      return then(next, (current) => failureAlert(current, result))
    }),
    FailedMerge: ({ error }) => alert(modifyFields(model, { merge: (merge) => ({ ...merge, isMerging: false }) }), "Merge failed", error),

    // GIT: PUBLISH DIALOG

    GotPublishDialogMessage: ({ message: child }) => {
      const step = dialogStep(Dialog.update(model.publish.dialog, child), publishDialogMessage)
      return { model: modifyFields(model, { publish: (publish) => ({ ...publish, dialog: step.dialog, ...(step.closed ? { token: publish.token + 1 } : {}) }) }), commands: step.commands }
    },
    SucceededPublishInfo: ({ token, info }) => {
      if (token !== model.publish.token) return { model }
      const next = modifyFields(model, {
        publish: (publish) => ({ ...publish, info, isLoadingInfo: false, owner: info.owners[0] ?? info.activeAccountLogin ?? "", name: info.suggestedRepoName, visibility: "private" as const, description: "" }),
      })
      return checkAvailability(next)
    },
    FailedPublishInfo: ({ token }) => ({ model: token === model.publish.token ? modifyFields(model, { publish: (publish) => ({ ...publish, isLoadingInfo: false }) }) : model }),
    GotOwnerSelectMessage: ({ message: child }) => {
      const step = Select.update(model.publish.ownerSelect, child)
      const commands = Command.mapMessages(step.commands ?? [], (inner: Select.Message) => Message.GotOwnerSelectMessage({ message: inner })) as unknown as Cmd[]
      const next = modifyFields(model, { publish: (publish) => ({ ...publish, ownerSelect: step.model }) })
      if (step.outMessage?._tag === "Selected" && step.outMessage.value !== model.publish.owner) {
        const checked = checkAvailability(modifyFields(next, { publish: (publish) => ({ ...publish, owner: step.outMessage!.value as string }) }))
        return { model: checked.model, commands: [...commands, ...(checked.commands ?? [])] }
      }
      return { model: next, commands }
    },
    GotVisibilitySelectMessage: ({ message: child }) => {
      const step = Select.update(model.publish.visibilitySelect, child)
      const commands = Command.mapMessages(step.commands ?? [], (inner: Select.Message) => Message.GotVisibilitySelectMessage({ message: inner })) as unknown as Cmd[]
      const value = step.outMessage?._tag === "Selected" ? step.outMessage.value : null
      return {
        model: modifyFields(model, { publish: (publish) => ({ ...publish, visibilitySelect: step.model, ...(value === "public" || value === "private" ? { visibility: value } : {}) }) }),
        commands,
      }
    },
    ChangedPublishName: ({ value }) => checkAvailability(modifyFields(model, { publish: (publish) => ({ ...publish, name: value }) })),
    ChangedPublishDescription: ({ value }) => ({ model: modifyFields(model, { publish: (publish) => ({ ...publish, description: value }) }) }),
    ElapsedAvailabilityDelay: ({ token }) => needFacts((facts) => {
      if (token !== model.publish.token || !facts.chatId) return { model }
      return { model, commands: [CheckRepoAvailability({ chatId: facts.chatId, owner: model.publish.owner.trim(), name: model.publish.name.trim(), token })] }
    }),
    SucceededAvailability: ({ token, result }) => ({
      model: token === model.publish.token ? modifyFields(model, { publish: (publish) => ({ ...publish, availability: result, isCheckingAvailability: false }) }) : model,
    }),
    FailedAvailability: ({ token }) => ({
      model: token === model.publish.token ? modifyFields(model, { publish: (publish) => ({ ...publish, isCheckingAvailability: false }) }) : model,
    }),
    ClickedPublish: () => needFacts((facts) => {
      const publish = model.publish
      if (!publish.owner.trim() || !publish.name.trim() || !facts.chatId) return { model }
      if (!canPublish({ model } as never)) return { model }
      return {
        model: modifyFields(model, { publish: (current) => ({ ...current, isPublishing: true }) }),
        commands: [PublishToGitHub({ chatId: facts.chatId, owner: publish.owner.trim(), name: publish.name.trim(), visibility: publish.visibility, description: publish.description })],
      }
    }),
    ClickedPublishCancel: () => closePublish(model),
    SucceededPublish: ({ result }) => needFacts((facts) => {
      const next = { model: modifyFields(model, { publish: (publish) => ({ ...publish, isPublishing: false }) }), commands: result.snapshotChanged && facts.chatId ? [RefreshDiffs({ chatId: facts.chatId }) as Cmd] : [] }
      if (result.ok) {
        const closed = closePublish(next.model)
        return { model: closed.model, commands: [...next.commands, ...(closed.commands ?? [])] }
      }
      return then(next, (current) => failureAlert(current, result))
    }),
    FailedPublish: ({ error }) => alert(modifyFields(model, { publish: (publish) => ({ ...publish, isPublishing: false }) }), "Publish failed", error),

    FailedDiffFileAction: ({ title, error }) => alert(model, title, error),

    // TASKS, WORKFLOWS, SCHEDULES, ATTACHMENTS

    ClickedShowAllTasks: ({ shown }) => ({ model: modifyFields(model, { showAllTasks: () => shown }) }),
    ClickedTask: ({ toolId }) => needFacts((facts) => jumpToToolCall(model, facts, toolId)),
    ClickedSubChat: ({ chatId }) => withActions({ model }, openChatActions(app, chatId)),
    ClickedStopTask: ({ taskId }) => needFacts((facts) => stopTask(model, app, facts, taskId)),
    FailedStopTask: ({ taskId, error }) => ({
      model: modifyFields(model, { stopping: (stopping) => stopping.filter((id) => id !== taskId), stopError: () => error }),
    }),
    ClickedEditSchedule: ({ scheduleId, fromCard }) => needFacts((facts) => {
      // The card goes first: the composer is where the eye should land.
      const edited = editSchedule(model, app, facts, scheduleId)
      return fromCard ? { ...edited, commands: [dismissCard(SCHEDULES_LIST), ...(edited.commands ?? [])] } : edited
    }),
    ClickedScheduleRunChat: ({ chatId }) => withActions({ model }, openChatActions(app, chatId)),
    ClickedAttachment: ({ key }) => {
      // Opens in the viewer, the same full-size surface as a diff or a chart.
      const attachment = deriveSentAttachments(chatFacts(app, facts?.chatId ?? null).entries).find((candidate) => candidate.key === key)
      if (!attachment) return { model }
      return withActions({ model }, [viewer(ViewerStore.Message.OpenedItem({
        item: { kind: "attachment", attachment: ViewerStore.viewerAttachmentFromDisplay(attachment) },
        expanded: false,
        byKey: false,
      }))])
    },

    // PORTS

    TickedPorts: () => needFacts((facts) => readPorts(model, facts)),
    SucceededListPorts: ({ servers }) => ({ model: modifyFields(model, { ports: (ports) => ({ ...ports, servers, error: null, loaded: true, reading: false }) }) }),
    FailedListPorts: ({ error }) => ({ model: modifyFields(model, { ports: (ports) => ({ ...ports, error, loaded: true, reading: false }) }) }),
    ElapsedPostRunRefresh: ({ token }) => needFacts((facts) => (token === model.ports.postRunToken ? readPorts(model, facts) : { model })),
    GotPortsFilterMessage: ({ message: child }) => {
      const step = Popover.update(model.ports.filter, child)
      return {
        model: modifyFields(model, { ports: (ports) => ({ ...ports, filter: step.model }) }),
        commands: Command.mapMessages(step.commands ?? [], (inner: Popover.Message) => Message.GotPortsFilterMessage({ message: inner })) as unknown as Cmd[],
      }
    },
    ChosePortsScope: ({ scope }) => {
      // `close()` then the scope, as the popover's items did.
      const closed = Popover.close(model.ports.filter)
      return {
        model: modifyFields(model, { ports: (ports) => ({ ...ports, filter: closed.model, scope }) }),
        commands: Command.mapMessages(closed.commands ?? [], (inner: Popover.Message) => Message.GotPortsFilterMessage({ message: inner })) as unknown as Cmd[],
      }
    },
    ToggledPorts: () => needFacts((facts) => {
      const visible = model.ports.scope === "all" ? model.ports.servers : model.ports.servers.filter((server) => server.sameProject)
      return withActions({ model }, [setExpanded(facts.projectId, "ports", !storedExpanded(app, facts.projectId, "ports", visible.length))])
    }),
    ClickedPortsElsewhere: () => needFacts((facts) => withActions(
      { model: modifyFields(model, { ports: (ports) => ({ ...ports, scope: "all" as const }) }) },
      [setExpanded(facts.projectId, "ports", true)],
    )),
    ClickedPort: ({ port }) => openServer(model, app, port),
    SucceededExposePort: ({ port, publicUrl }) => ({
      model: modifyFields(model, {
        ports: (ports) => ({
          ...ports,
          exposingPorts: ports.exposingPorts.filter((candidate) => candidate !== port),
          servers: ports.servers.map((server) => (server.port === port ? { ...server, publicUrl } : server)),
        }),
      }),
    }),
    FailedPortCommand: ({ port, error }) => ({
      model: modifyFields(model, { ports: (ports) => ({ ...ports, error, exposingPorts: port === null ? ports.exposingPorts : ports.exposingPorts.filter((candidate) => candidate !== port) }) }),
    }),
    SucceededKillPort: () => needFacts((facts) => readPorts(model, facts)),

    // QUICK ACTIONS

    ToggledQuickActions: () => needFacts((facts) => {
      const count = currentQuickActions(model, app, facts).length
      const error = model.quickActions.error ?? app.chatPage.quickActionsError
      const open = storedExpanded(app, facts.projectId, "quickActions", count) || model.quickActions.isAdding || error !== null
      if (open) {
        return withActions({ model: modifyFields(model, { quickActions: (state) => ({ ...state, isAdding: false }) }) }, [setExpanded(facts.projectId, "quickActions", false)])
      }
      return withActions(
        { model: count === 0 ? modifyFields(model, { quickActions: (state) => ({ ...state, isAdding: true }) }) : model },
        [setExpanded(facts.projectId, "quickActions", true)],
      )
    }),
    ClickedAddQuickAction: () => needFacts((facts) => {
      const adding = model.quickActions.isAdding
      const next = modifyFields(model, { quickActions: (state) => ({ ...state, isAdding: !adding }) })
      // Opening the composer opens the section with it.
      return adding ? { model: next } : withActions({ model: next }, [setExpanded(facts.projectId, "quickActions", true)])
    }),
    ChangedNewCommand: ({ value }) => ({ model: modifyFields(model, { quickActions: (state) => ({ ...state, newCommand: value }) }) }),
    SubmittedQuickAction: () => needFacts((facts) => {
      const command = model.quickActions.newCommand.trim()
      if (!command) return { model }
      const current = currentQuickActions(model, app, facts)
      const id = globalThis.crypto?.randomUUID?.() ?? `quick-action-${Date.now()}`
      const written = writeQuickActions(model, facts.projectId, [...current, { id, label: command, command }])
      return { ...written, model: modifyFields(written.model, { quickActions: (state) => ({ ...state, newCommand: "", isAdding: false }) }) }
    }),
    LeftQuickActionForm: () => needFacts((facts) => {
      if (model.quickActions.pressInWidget) return { model }
      const next = modifyFields(model, { quickActions: (state) => ({ ...state, isAdding: false }) })
      // With nothing saved the form was the whole body; leaving it folds the section back.
      return currentQuickActions(model, app, facts).length === 0
        ? withActions({ model: next }, [setExpanded(facts.projectId, "quickActions", false)])
        : { model: next }
    }),
    PressedInQuickActions: () => ({ model: modifyFields(model, { quickActions: (state) => ({ ...state, pressInWidget: true }) }), commands: [AwaitPointerUp()] }),
    ReleasedPressInQuickActions: () => ({ model: modifyFields(model, { quickActions: (state) => ({ ...state, pressInWidget: false }) }) }),
    RanQuickAction: ({ id }) => {
      const ranToken = model.quickActions.ranToken + 1
      const postRunToken = model.ports.postRunToken + 1
      return {
        model: modifyFields(model, {
          quickActions: (state) => ({ ...state, ranActionId: id, ranToken }),
          ports: (ports) => ({ ...ports, postRunToken }),
        }),
        // A server it starts takes a moment to bind its port: re-check shortly after.
        commands: [
          ExpireRanQuickAction({ token: ranToken }),
          WaitPostRunRefresh({ token: postRunToken, delayMs: 1_000 }),
          WaitPostRunRefresh({ token: postRunToken, delayMs: 2_000 }),
        ],
      }
    },
    ExpiredRanQuickAction: ({ token }) => ({ model: token === model.quickActions.ranToken ? modifyFields(model, { quickActions: (state) => ({ ...state, ranActionId: null }) }) : model }),
    SucceededWriteQuickActions: ({ projectId, actions }) => ({
      model: modifyFields(model, { quickActions: (state) => ({ ...state, written: { projectId, actions }, error: null }) }),
    }),
    FailedWriteQuickActions: ({ error }) => ({ model: modifyFields(model, { quickActions: (state) => ({ ...state, error }) }) }),

    // USAGE

    ToggledUsage: ({ provider }) => needFacts((facts) => {
      const id = `usage:${provider}` as RightSidebar.WidgetDisclosureId
      const windows = app.chatPage.usageLimits?.providers.find((usage) => usage.provider === provider)?.windows.length ?? 0
      return withActions({ model }, [setExpanded(facts.projectId, id, !storedExpanded(app, facts.projectId, id, windows))])
    }),
    ClickedRefreshUsage: ({ basis }) => (model.usageRefreshing ? { model } : { model: modifyFields(model, { usageRefreshing: () => true }), commands: [RefreshUsage({ basis })] }),
    CompletedRefreshUsage: ({ basis, snapshot }) => ({
      model: modifyFields(model, { usageRefreshing: () => false, usageOverride: (current) => (snapshot ? { basis, snapshot } : current) }),
    }),
  })
}

// MERGE AND PUBLISH: OPENING AND CLOSING

function openMerge(model: Model, facts: Facts): Return {
  const token = model.merge.token + 1
  const opened = dialogStep(Dialog.open(model.merge.dialog), mergeDialogMessage)
  return {
    model: modifyFields(model, { merge: (merge) => ({ ...merge, dialog: opened.dialog, branchList: null, token }) }),
    commands: [...opened.commands, ...(facts.chatId ? [ListMergeBranches({ chatId: facts.chatId, token })] : [])],
  }
}

/** While closed the dialog forgets its search, selection and preview. */
function resetMerge(model: Model): Model {
  return modifyFields(model, {
    merge: (merge) => ({ ...merge, query: "", selectedName: null, preview: null, previewError: null, isPreviewLoading: false, isMerging: false, token: merge.token + 1 }),
  })
}

function closeMerge(model: Model): Return {
  const closed = dialogStep(Dialog.close(model.merge.dialog), mergeDialogMessage)
  return { model: resetMerge(modifyFields(model, { merge: (merge) => ({ ...merge, dialog: closed.dialog }) })), commands: closed.commands }
}

function openPublish(model: Model, facts: Facts): Return {
  const token = model.publish.token + 1
  const opened = dialogStep(Dialog.open(model.publish.dialog), publishDialogMessage)
  return {
    model: modifyFields(model, { publish: (publish) => ({ ...publish, dialog: opened.dialog, isLoadingInfo: true, availability: null, token }) }),
    commands: [...opened.commands, ...(facts.chatId ? [GetPublishInfo({ chatId: facts.chatId, token })] : [])],
  }
}

function closePublish(model: Model): Return {
  const closed = dialogStep(Dialog.close(model.publish.dialog), publishDialogMessage)
  return { model: modifyFields(model, { publish: (publish) => ({ ...publish, dialog: closed.dialog, token: publish.token + 1 }) }), commands: closed.commands }
}

/** The availability check, 250ms after the owner or name settles. */
function checkAvailability(model: Model): Return {
  const publish = model.publish
  if (!publish.info?.ghInstalled || !publish.info.authenticated) return { model }
  const token = publish.token + 1
  if (!publish.owner.trim() || !publish.name.trim()) {
    return { model: modifyFields(model, { publish: (current) => ({ ...current, availability: null, token }) }) }
  }
  return {
    model: modifyFields(model, { publish: (current) => ({ ...current, isCheckingAvailability: true, token }) }),
    commands: [WaitAvailabilityDelay({ token })],
  }
}

// COMMIT ONLY

function commitOnly(model: Model, app: AppModel, facts: Facts): Return {
  const git = gitFactsOf(model, app, facts.projectId)
  if (!git.canCommit) return { model }
  return commit(model, app, facts, "commit_only", null)
}

// THE APP DIALOG'S ANSWERS

function answerDialog(model: Model, continuation: DialogContinuation, answer: AppDialog.Answer): Return {
  switch (continuation._tag) {
    case "None":
      return { model }
    case "DiscardFile":
      return answer._tag === "Confirm" && answer.confirmed
        ? { model, commands: [DiffFileAction({ kind: "discard", chatId: continuation.chatId, path: continuation.path })] }
        : { model }
    case "IgnoreFile": {
      if (answer._tag === "Confirm") {
        return answer.confirmed && model.menuTarget?._tag === "DiffFile"
          ? { model, commands: [DiffFileAction({ kind: "ignore", chatId: continuation.chatId, path: model.menuTarget.path })] }
          : { model }
      }
      if (answer._tag === "Prompt" && Option.isSome(answer.value)) {
        return { model, commands: [DiffFileAction({ kind: "ignore", chatId: continuation.chatId, path: answer.value.value })] }
      }
      return { model }
    }
    case "CheckoutBranch": {
      if (answer._tag === "Confirm" && answer.confirmed) {
        return { model, commands: [CheckoutBranch({ chatId: continuation.chatId, branch: continuation.branch, bringChanges: true, pickerToken: continuation.pickerToken })] }
      }
      // "Stay Here": nothing changes, and the picker closes (runMutation's onDone).
      return { model: finishPickerMutation(model, continuation.pickerToken) }
    }
  }
}

// HOVER

function hover(model: Model, app: AppModel, facts: Facts | null, message: HoverMessage): Return {
  if (message._tag !== "ChangedHoveredRow") return { model }
  const next = modifyFields(model, { hovered: (hovered) => applyHover(hovered, message.list, message.key) })
  if (message.key === null || !facts) return { model: next }
  return { model: next, commands: [AwaitCardPaint({ list: message.list, key: message.key })] }
}

/** The list as the column shows it: what it last wrote, else the page's read (`app.chatPage`, read-only). */
function currentQuickActions(model: Model, app: AppModel, facts: Facts) {
  const written = model.quickActions.written
  if (written && written.projectId === facts.projectId) return written.actions
  return app.chatPage.quickActions[facts.projectId] ?? []
}
