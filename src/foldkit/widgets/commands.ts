import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { serializeBranchSelection } from "../../client/app/ChatPage/utils"
import type { LocalHttpServerInfo, ProjectQuickAction } from "../../shared/protocol"
import type {
  BranchActionFailure,
  BranchActionSuccess,
  ChatBranchDetails,
  ChatBranchListResult,
  ChatCheckoutBranchResult,
  ChatCommitDetails,
  ChatCreateBranchResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  ChatSyncResult,
  DiffCommitResult,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
  UsageLimitsSnapshot,
} from "../../shared/types"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand } from "../core/socket"
import { Message } from "./message"
import { CommitMode, Entry, SyncAction } from "./model"

// The column's server commands (useChatPageSidebarActions' handlers and the
// widgets' own reads), each a result Message out. Errors come back as text,
// for the alert or the line the widget shows.

const done = () => Message.CompletedSideEffect()
const asText = (error: unknown) => errorMessage(error)

// GIT

export const RefreshDiffs = Command.define("WidgetsRefreshDiffs", {
  args: { chatId: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ chatId }) => sendCommand({ type: "chat.refreshDiffs", chatId }).pipe(Effect.ignore, Effect.as(done())),
})

export const SyncBranch = Command.define("WidgetsSyncBranch", {
  args: { chatId: Schema.String, action: SyncAction },
  messages: [Message.SucceededSync, Message.FailedSync],
  execute: ({ chatId, action }) => sendCommand<ChatSyncResult>({ type: "chat.syncBranch", chatId, action }).pipe(
    Effect.map((result) => Message.SucceededSync({ result })),
    Effect.catch((error) => Effect.succeed(Message.FailedSync({ error: asText(error) }))),
  ),
})

export const GenerateCommitMessage = Command.define("WidgetsGenerateCommitMessage", {
  args: { projectId: Schema.String, paths: Schema.Array(Schema.String), thenCommit: Schema.NullOr(CommitMode) },
  messages: [Message.SucceededGenerateMessage, Message.FailedGenerateMessage],
  execute: ({ projectId, paths, thenCommit }) => sendCommand<{ subject: string; body: string }>({ type: "project.generateCommitMessage", projectId, paths: [...paths] }).pipe(
    Effect.map((result) => Message.SucceededGenerateMessage({ subject: result.subject, body: result.body, thenCommit })),
    Effect.catch(() => Effect.succeed(Message.FailedGenerateMessage())),
  ),
})

export const CommitDiffs = Command.define("WidgetsCommitDiffs", {
  args: { projectId: Schema.String, paths: Schema.Array(Schema.String), summary: Schema.String, description: Schema.String, mode: CommitMode },
  messages: [Message.SucceededCommit, Message.FailedCommit],
  execute: ({ projectId, paths, summary, description, mode }) => sendCommand<DiffCommitResult>({
    type: "project.commitDiffs",
    projectId,
    paths: [...paths],
    summary,
    description,
    mode,
  }).pipe(
    Effect.map((result) => Message.SucceededCommit({ result })),
    Effect.catch((error) => Effect.succeed(Message.FailedCommit({ error: asText(error) }))),
  ),
})

export const InitGit = Command.define("WidgetsInitGit", {
  args: { chatId: Schema.String },
  messages: [Message.SucceededInitGit, Message.FailedInitGit],
  execute: ({ chatId }) => sendCommand<BranchActionSuccess | BranchActionFailure>({ type: "chat.initGit", chatId }).pipe(
    Effect.map((result) => Message.SucceededInitGit({ result })),
    Effect.catch((error) => Effect.succeed(Message.FailedInitGit({ error: asText(error) }))),
  ),
})

export const ListBranches = Command.define("WidgetsListBranches", {
  args: { chatId: Schema.String, token: Schema.Number },
  messages: [Message.SucceededListBranches, Message.FailedListBranches],
  execute: ({ chatId, token }) => sendCommand<ChatBranchListResult>({ type: "chat.listBranches", chatId }).pipe(
    Effect.map((result) => Message.SucceededListBranches({ token, result })),
    Effect.catch((error) => Effect.succeed(Message.FailedListBranches({ token, error: asText(error) }))),
  ),
})

export const CheckoutBranch = Command.define("WidgetsCheckoutBranch", {
  args: { chatId: Schema.String, branch: Entry, bringChanges: Schema.Boolean, pickerToken: Schema.Number },
  messages: [Message.SucceededCheckout, Message.FailedBranchMutation],
  execute: ({ chatId, branch, bringChanges, pickerToken }) => sendCommand<ChatCheckoutBranchResult>({
    type: "chat.checkoutBranch",
    chatId,
    branch: serializeBranchSelection(branch),
    bringChanges,
  }).pipe(
    Effect.map((result) => Message.SucceededCheckout({ pickerToken, result })),
    Effect.catch((error) => Effect.succeed(Message.FailedBranchMutation({ pickerToken, title: "Checkout failed", error: asText(error) }))),
  ),
})

export const CreateBranch = Command.define("WidgetsCreateBranch", {
  args: { chatId: Schema.String, name: Schema.String, baseBranchName: Schema.NullOr(Schema.String), pickerToken: Schema.Number },
  messages: [Message.SucceededCreateBranch, Message.FailedBranchMutation],
  execute: ({ chatId, name, baseBranchName, pickerToken }) => sendCommand<ChatCreateBranchResult>({
    type: "chat.createBranch",
    chatId,
    name,
    baseBranchName: baseBranchName ?? undefined,
  }).pipe(
    Effect.map((result) => Message.SucceededCreateBranch({ pickerToken, result })),
    Effect.catch((error) => Effect.succeed(Message.FailedBranchMutation({ pickerToken, title: "Create branch failed", error: asText(error) }))),
  ),
})

export const ReadBranch = Command.define("WidgetsReadBranch", {
  args: { projectId: Schema.String, key: Schema.String, entry: Entry },
  messages: [Message.SucceededReadBranch, Message.FailedReadBranch],
  execute: ({ projectId, key, entry }) => sendCommand<ChatBranchDetails>({ type: "project.readBranch", projectId, branch: serializeBranchSelection(entry) }).pipe(
    Effect.map((details) => Message.SucceededReadBranch({ key, details })),
    Effect.catch(() => Effect.succeed(Message.FailedReadBranch({ key }))),
  ),
})

export const ReadCommit = Command.define("WidgetsReadCommit", {
  args: { projectId: Schema.String, key: Schema.String, sha: Schema.String },
  messages: [Message.SucceededReadCommit, Message.FailedReadCommit],
  execute: ({ projectId, key, sha }) => sendCommand<ChatCommitDetails>({ type: "project.readCommit", projectId, sha }).pipe(
    Effect.map((details) => Message.SucceededReadCommit({ key, details })),
    Effect.catch(() => Effect.succeed(Message.FailedReadCommit({ key }))),
  ),
})

export const ReadDiffPatch = Command.define("WidgetsReadDiffPatch", {
  args: { projectId: Schema.String, key: Schema.String, path: Schema.String },
  messages: [Message.SucceededReadPatch, Message.FailedReadPatch],
  execute: ({ projectId, key, path }) => sendCommand<{ patch: string }>({ type: "project.readDiffPatch", projectId, path }).pipe(
    Effect.map((result) => Message.SucceededReadPatch({ key, patch: result.patch })),
    Effect.catch(() => Effect.succeed(Message.FailedReadPatch({ key }))),
  ),
})

export const PreviewMerge = Command.define("WidgetsPreviewMerge", {
  args: { chatId: Schema.String, branch: Entry, token: Schema.Number },
  messages: [Message.SucceededMergePreview, Message.FailedMergePreview],
  execute: ({ chatId, branch, token }) => sendCommand<ChatMergePreviewResult>({ type: "chat.previewMergeBranch", chatId, branch: serializeBranchSelection(branch) }).pipe(
    Effect.map((result) => Message.SucceededMergePreview({ token, result })),
    Effect.catch((error) => Effect.succeed(Message.FailedMergePreview({ token, error: asText(error) }))),
  ),
})

/** The merge dialog's own branch list. A failed read is an empty list, not a skeleton forever. */
export const ListMergeBranches = Command.define("WidgetsListMergeBranches", {
  args: { chatId: Schema.String, token: Schema.Number },
  messages: [Message.SucceededMergeList],
  execute: ({ chatId, token }) => sendCommand<ChatBranchListResult>({ type: "chat.listBranches", chatId }).pipe(
    Effect.map((result) => Message.SucceededMergeList({ token, result })),
    Effect.catch(() => Effect.succeed(Message.SucceededMergeList({
      token,
      result: { recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "error" },
    }))),
  ),
})

export const MergeBranch = Command.define("WidgetsMergeBranch", {
  args: { chatId: Schema.String, branch: Entry },
  messages: [Message.SucceededMerge, Message.FailedMerge],
  execute: ({ chatId, branch }) => sendCommand<ChatMergeBranchResult>({ type: "chat.mergeBranch", chatId, branch: serializeBranchSelection(branch) }).pipe(
    Effect.map((result) => Message.SucceededMerge({ result })),
    Effect.catch((error) => Effect.succeed(Message.FailedMerge({ error: asText(error) }))),
  ),
})

export const GetPublishInfo = Command.define("WidgetsGetPublishInfo", {
  args: { chatId: Schema.String, token: Schema.Number },
  messages: [Message.SucceededPublishInfo, Message.FailedPublishInfo],
  execute: ({ chatId, token }) => sendCommand<GitHubPublishInfo>({ type: "chat.getGitHubPublishInfo", chatId }).pipe(
    Effect.map((info) => Message.SucceededPublishInfo({ token, info })),
    Effect.catch(() => Effect.succeed(Message.FailedPublishInfo({ token }))),
  ),
})

export const WaitAvailabilityDelay = Command.define("WidgetsWaitAvailabilityDelay", {
  args: { token: Schema.Number },
  messages: [Message.ElapsedAvailabilityDelay],
  execute: ({ token }) => Effect.sleep(Duration.millis(250)).pipe(Effect.as(Message.ElapsedAvailabilityDelay({ token }))),
})

export const CheckRepoAvailability = Command.define("WidgetsCheckRepoAvailability", {
  args: { chatId: Schema.String, owner: Schema.String, name: Schema.String, token: Schema.Number },
  messages: [Message.SucceededAvailability, Message.FailedAvailability],
  execute: ({ chatId, owner, name, token }) => sendCommand<GitHubRepoAvailabilityResult>({ type: "chat.checkGitHubRepoAvailability", chatId, owner, name }).pipe(
    Effect.map((result) => Message.SucceededAvailability({ token, result })),
    Effect.catch(() => Effect.succeed(Message.FailedAvailability({ token }))),
  ),
})

export const PublishToGitHub = Command.define("WidgetsPublishToGitHub", {
  args: { chatId: Schema.String, owner: Schema.String, name: Schema.String, visibility: Schema.Literals(["public", "private"]), description: Schema.String },
  messages: [Message.SucceededPublish, Message.FailedPublish],
  execute: ({ chatId, owner, name, visibility, description }) => sendCommand<BranchActionSuccess | BranchActionFailure>({
    type: "chat.publishToGitHub",
    chatId,
    owner,
    name,
    visibility,
    description: description.trim() || undefined,
  }).pipe(
    Effect.map((result) => Message.SucceededPublish({ result })),
    Effect.catch((error) => Effect.succeed(Message.FailedPublish({ error: asText(error) }))),
  ),
})

/** A diff file's action after its confirm (`chat.discardDiffFile`, `chat.ignoreDiffFile`). */
export const DiffFileAction = Command.define("WidgetsDiffFileAction", {
  args: { kind: Schema.Literals(["discard", "ignore"]), chatId: Schema.String, path: Schema.String },
  messages: [Message.CompletedSideEffect, Message.FailedDiffFileAction],
  execute: ({ kind, chatId, path }) => sendCommand(kind === "discard"
    ? { type: "chat.discardDiffFile", chatId, path }
    : { type: "chat.ignoreDiffFile", chatId, path }).pipe(
    Effect.as(done()),
    Effect.catch((error) => Effect.succeed(Message.FailedDiffFileAction({ title: kind === "discard" ? "Discard failed" : "Ignore failed", error: asText(error) }))),
  ),
})

export const ExpireCopiedSha = Command.define("WidgetsExpireCopiedSha", {
  args: { token: Schema.Number },
  messages: [Message.ExpiredCopiedSha],
  execute: ({ token }) => Effect.sleep(Duration.millis(1_200)).pipe(Effect.as(Message.ExpiredCopiedSha({ token }))),
})

// BROWSER: COPY, OPEN

export const CopyText = Command.define("WidgetsCopyText", {
  args: { text: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ text }) => Effect.promise(() => navigator.clipboard?.writeText(text) ?? Promise.resolve()).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.as(done()),
  ),
})

export const OpenInNewTab = Command.define("WidgetsOpenInNewTab", {
  args: { url: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ url }) => Effect.sync(() => {
    window.open(url, "_blank", "noopener,noreferrer")
    return done()
  }),
})

// TASKS

export const StopTask = Command.define("WidgetsStopTask", {
  args: { chatId: Schema.String, taskId: Schema.String },
  messages: [Message.CompletedSideEffect, Message.FailedStopTask],
  execute: ({ chatId, taskId }) => sendCommand({ type: "chat.stopTask", chatId, taskId }).pipe(
    Effect.as(done()),
    Effect.catch((error) => Effect.succeed(Message.FailedStopTask({ taskId, error: asText(error) }))),
  ),
})

// PORTS

/** Only what answers 2xx or 3xx is listed (localServersCache's visibleLocalHttpServers). */
function visibleLocalHttpServers(servers: LocalHttpServerInfo[]) {
  return servers.filter((server) => server.status >= 200 && server.status < 400)
}

export const ListPorts = Command.define("WidgetsListPorts", {
  args: { projectId: Schema.String },
  messages: [Message.SucceededListPorts, Message.FailedListPorts],
  execute: ({ projectId }) => sendCommand<LocalHttpServerInfo[]>({ type: "browser.listLocalHttpServers", projectId }).pipe(
    Effect.map((servers) => Message.SucceededListPorts({ servers: visibleLocalHttpServers(servers) })),
    Effect.catch((error) => Effect.succeed(Message.FailedListPorts({ error: asText(error) }))),
  ),
})

export const WaitPostRunRefresh = Command.define("WidgetsWaitPostRunRefresh", {
  args: { token: Schema.Number, delayMs: Schema.Number },
  messages: [Message.ElapsedPostRunRefresh],
  execute: ({ token, delayMs }) => Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(Message.ElapsedPostRunRefresh({ token }))),
})

export const ExposePort = Command.define("WidgetsExposePort", {
  args: { port: Schema.Number },
  messages: [Message.SucceededExposePort, Message.FailedPortCommand],
  execute: ({ port }) => sendCommand<{ port: number; publicUrl: string }>({ type: "browser.exposeLocalHttpServer", port }).pipe(
    Effect.map((result) => Message.SucceededExposePort({ port, publicUrl: result.publicUrl })),
    Effect.catch((error) => Effect.succeed(Message.FailedPortCommand({ port, error: asText(error) }))),
  ),
})

export const UnexposePort = Command.define("WidgetsUnexposePort", {
  args: { port: Schema.Number },
  messages: [Message.CompletedSideEffect, Message.FailedPortCommand],
  execute: ({ port }) => sendCommand({ type: "browser.unexposeLocalHttpServer", port }).pipe(
    Effect.as(done()),
    Effect.catch((error) => Effect.succeed(Message.FailedPortCommand({ port: null, error: asText(error) }))),
  ),
})

export const KillPort = Command.define("WidgetsKillPort", {
  args: { port: Schema.Number },
  messages: [Message.SucceededKillPort, Message.FailedPortCommand],
  execute: ({ port }) => sendCommand({ type: "browser.killLocalHttpServer", port }).pipe(
    Effect.as(Message.SucceededKillPort()),
    Effect.catch((error) => Effect.succeed(Message.FailedPortCommand({ port: null, error: asText(error) }))),
  ),
})

// QUICK ACTIONS

export const WriteQuickActions = Command.define("WidgetsWriteQuickActions", {
  args: { projectId: Schema.String, actions: Schema.Array(opaque<ProjectQuickAction>("ProjectQuickAction")) },
  messages: [Message.SucceededWriteQuickActions, Message.FailedWriteQuickActions],
  execute: ({ projectId, actions }) => sendCommand<ProjectQuickAction[]>({ type: "project.writeQuickActions", projectId, quickActions: [...actions] }).pipe(
    Effect.map((saved) => Message.SucceededWriteQuickActions({ projectId, actions: saved })),
    Effect.catch((error) => Effect.succeed(Message.FailedWriteQuickActions({ error: asText(error) }))),
  ),
})

export const ExpireRanQuickAction = Command.define("WidgetsExpireRanQuickAction", {
  args: { token: Schema.Number },
  messages: [Message.ExpiredRanQuickAction],
  execute: ({ token }) => Effect.sleep(Duration.millis(1_000)).pipe(Effect.as(Message.ExpiredRanQuickAction({ token }))),
})

/** The press that began in the widget is decided once its click has been handled. */
export const AwaitPointerUp = Command.define("WidgetsAwaitPointerUp", {
  messages: [Message.ReleasedPressInQuickActions],
  execute: Effect.callback<typeof Message.ReleasedPressInQuickActions.Type>((resume) => {
    const release = () => setTimeout(() => resume(Effect.succeed(Message.ReleasedPressInQuickActions())), 0)
    window.addEventListener("pointerup", release, { once: true })
    return Effect.sync(() => window.removeEventListener("pointerup", release))
  }),
})

// USAGE

export const RefreshUsage = Command.define("WidgetsRefreshUsage", {
  args: { basis: Schema.String },
  messages: [Message.CompletedRefreshUsage],
  execute: ({ basis }) => sendCommand<UsageLimitsSnapshot>({ type: "usage.refresh", force: true }).pipe(
    Effect.map((result) => Message.CompletedRefreshUsage({ basis, snapshot: result && Array.isArray(result.providers) ? result : null })),
    Effect.catch(() => Effect.succeed(Message.CompletedRefreshUsage({ basis, snapshot: null }))),
  ),
})

// FOCUS AND SCROLL

/** Focus a field by id: the commit message on the pencil, the picker's search where there is a keyboard. */
export const FocusById = Command.define("WidgetsFocusById", {
  args: { id: Schema.String, finePointerOnly: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ id, finePointerOnly }) => Effect.sync(() => {
    // A frame later, once the field is in the DOM (requestAnimationFrame in React).
    requestAnimationFrame(() => {
      if (finePointerOnly && !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return
      document.getElementById(id)?.focus({ preventScroll: true })
    })
    return done()
  }),
})

/** After a prefill: the composer takes focus with the caret at the end (ChatInput's `prefill`). */
export const FocusComposerAtEnd = Command.define("WidgetsFocusComposerAtEnd", {
  messages: [Message.CompletedSideEffect],
  execute: Effect.sync(() => {
    requestAnimationFrame(() => {
      const element = document.querySelector<HTMLTextAreaElement>("textarea[data-chat-input]")
      if (!element) return
      element.focus()
      element.selectionStart = element.value.length
      element.selectionEnd = element.value.length
    })
    return done()
  }),
})

/** Keeps a row in sight: the keyboard cursor, the file the viewer is on. */
export const ScrollIntoView = Command.define("WidgetsScrollIntoView", {
  args: { selector: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ selector }) => Effect.sync(() => {
    requestAnimationFrame(() => document.querySelector(selector)?.scrollIntoView({ block: "nearest" }))
    return done()
  }),
})
