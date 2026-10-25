import { version as KANNA_VERSION } from "../../package.json"
import { getDefaultEditorCommandTemplate } from "../shared/editor-presets"
import type {
  ClientCommand,
  ClientEnvelope,
  ProjectQuickAction,
  ServerEnvelope,
  ServerSnapshot,
  SubscriptionTopic,
  TerminalTailResult,
} from "../shared/protocol"
import { mergeAppSettingsPatch } from "../client/stores/appSettingsStore"
import { cloneTranscriptEntriesForClient } from "../server/events"
import { existingAccountId, type AccountInput, type ProviderAccount } from "../shared/accounts"
import type { McpServerInput, McpServerSummary, McpSnapshot } from "../shared/mcp"
import { createDefaultProviderDefaults } from "../shared/provider-preferences"
import {
  buildTranscriptOutline,
  DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  findTranscriptWindowStart,
} from "../shared/transcript-window"
import {
  AUTH_SERVICE_LABELS,
  AUTH_SERVICE_ORDER,
  DEFAULT_KEYBINDINGS,
  DEFAULT_OPENROUTER_SDK_MODEL,
  DEFAULT_PI_FAVE_MODELS,
  PROVIDERS,
  type AgentProvider,
  type AppSettingsSnapshot,
  type AppThemePreference,
  type ChatAttachment,
  type ChatBranchDetails,
  type ChatBranchHistoryEntry,
  type ChatBranchListEntry,
  type ChatBranchListResult,
  type ChatCommitDetails,
  type ChatDiffFile,
  type ChatDiffSnapshot,
  type ChatMergePreviewResult,
  type ChatPreview,
  type ChatSchedule,
  type ChatSkillsSnapshot,
  type ChatSnapshot,
  type ChatTouchedFilesResult,
  type FsListResult,
  type GitHubPublishInfo,
  type GitHubRecentReposResult,
  type GitHubRepoAvailabilityResult,
  type GlobalSkillSummary,
  type HarnessSkill,
  type KannaStatus,
  type KeybindingAction,
  type KeybindingsSnapshot,
  type LlmProviderSnapshot,
  type LocalProjectsSnapshot,
  type ProviderAuthSnapshot,
  type QueuedChatMessage,
  type SidebarChatRow,
  type SidebarData,
  type SkillSearchResult,
  type StandaloneTranscriptExportFailureResult,
  type SubagentActivity,
  type TranscriptEntry,
  type UpdateSnapshot,
  type UsageLimitsSnapshot,
} from "../shared/types"
import { createUnifiedPatch } from "./patch"
import {
  composeScriptedReply,
  createDemoChats,
  DEMO_HOME,
  DEMO_PROJECTS,
  titleFromPrompt,
  type DemoChatSeed,
  type DemoProjectSeed,
} from "./scenario"
import type { DemoStep, EntryDraft } from "./script"
import { DemoShell } from "./terminal"

export const DEMO_UNAVAILABLE_MESSAGE = "That isn't part of the demo. Install Kanna to use it: bun install -g kanna-code"

/**
 * Commands the demo answers on purpose with "needs your machine": opening an
 * app, signing in a CLI. Unlike DEMO_UNAVAILABLE_MESSAGE, which marks a
 * command the demo has no answer for at all, these are handled, and the
 * client shows the reason.
 */
export const DEMO_NEEDS_MACHINE_MESSAGE = "This needs Kanna running on your own machine. Install it with: bun install -g kanna-code"

export interface DemoClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const browserClock: DemoClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface ProjectState {
  seed: DemoProjectSeed
  /** The sidebar's name for it; `project.rename` changes it. */
  title: string
  /** Pinned in the Channels view, and when. */
  pinnedAt?: number
  /** Hidden from the sidebar (`project.remove`); `project.open` brings it back. */
  hidden?: boolean
  /** The working tree. */
  files: Map<string, string>
  /** The last commit. The diff panel shows `files` against this. */
  head: Map<string, string>
  /** Checked out now, and every local branch. */
  branchName: string
  branches: string[]
  /** Commits on the checked-out branch, newest first. */
  history: DemoCommit[]
  quickActions: ProjectQuickAction[]
}

interface DemoCommit extends ChatBranchHistoryEntry {
  files: { path: string; additions: number; deletions: number }[]
}

interface ActiveTurn {
  steps: DemoStep[]
  index: number
  timer: unknown | null
  question: DemoStep["question"] | null
}

interface ChatState {
  id: string
  projectId: string
  title: string
  provider: AgentProvider | null
  model: string | null
  createdAt: number
  lastMessageAt?: number
  lastAgentMessageAt?: number
  lastTurnStartedAt?: number
  lastTurnEndedAt?: number
  turnCount: number
  unread: boolean
  doneAt?: number
  pinnedAt?: number
  archivedAt?: number
  /** Hands work to the chats under it (`chat.setDelegator`). */
  delegator?: boolean
  /** The last send asked for a plan first. */
  planMode: boolean
  /** Background work for the Tasks widget (runtime.subagents). */
  tasks: SubagentActivity[]
  /** What the chat's agent set to run later, for the Schedules widget (runtime.schedules). */
  schedules: ChatSchedule[]
  entries: TranscriptEntry[]
  queued: QueuedChatMessage[]
  turn: ActiveTurn | null
  /** Paths this chat's turns wrote, for the sidebar's uncommitted-work dot. */
  touchedPaths: Set<string>
}

interface OutgoingMessage {
  content: string
  attachments: ChatAttachment[]
  provider?: AgentProvider
  model?: string
  planMode?: boolean
}

function statusLetter(project: ProjectState, path: string) {
  if (!project.head.has(path)) return "??"
  if (!project.files.has(path)) return " D"
  return " M"
}

function hashString(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

function defaultModelFor(provider: AgentProvider) {
  return PROVIDERS.find((entry) => entry.id === provider)?.defaultModel ?? "opus"
}

/**
 * Stands in for the Kanna server. It speaks the same envelopes over a fake
 * WebSocket, so the real client runs unmodified on top of it: projects,
 * chats and a working tree live in memory, and turns play from scripts.
 *
 * Snapshots are recomputed and deduped per subscription after every change,
 * the same property the real router keeps, so a push only goes out when what
 * that subscriber sees actually moved.
 */
export class DemoBackend {
  private readonly projects = new Map<string, ProjectState>()
  private readonly chats = new Map<string, ChatState>()
  private readonly subscriptions = new Map<string, SubscriptionTopic>()
  private readonly lastSent = new Map<string, string>()
  private readonly shells = new Map<string, DemoShell>()
  /** Where each chat subscription's transcript window starts (see shared/transcript-window.ts). */
  private readonly windowStarts = new Map<string, number>()
  private appSettings: AppSettingsSnapshot
  private keybindings: KeybindingsSnapshot = createKeybindings()
  private llmProvider: LlmProviderSnapshot = createLlmProvider()
  private mcpServers: McpServerSummary[] = createMcpServers()
  private mcpRevision = 1
  private globalSkills: GlobalSkillSummary[] = createGlobalSkills()
  private accounts: ProviderAccount[] = createAccounts()
  private defaultAccountIds: Partial<Record<AgentProvider, string>> = { claude: existingAccountId("claude"), codex: existingAccountId("codex") }
  private idCounter = 0
  private started = false

  constructor(
    private readonly send: (envelope: ServerEnvelope) => void,
    private readonly clock: DemoClock = browserClock,
    options: { theme?: AppThemePreference } = {},
  ) {
    this.appSettings = createDemoAppSettings(options.theme ?? "dark")
    for (const seed of DEMO_PROJECTS) this.addProject(seed)
    for (const seed of createDemoChats()) this.seedChat(seed)
  }

  private addProject(seed: DemoProjectSeed) {
    const files = new Map(Object.entries(seed.files))
    const project: ProjectState = {
      seed,
      title: seed.title,
      files,
      head: new Map(files),
      branchName: seed.branchName,
      branches: [...new Set([seed.branchName, "main"])],
      history: [],
      quickActions: [],
    }
    // A project made in the demo was just made; the seeded ones go back a while.
    this.commit(project, "Initial commit", [...files.keys()], this.clock.now() - (seed.localOnly ? 0 : 9 * 24 * 60 * 60_000))
    this.projects.set(seed.id, project)
    return project
  }

  /** Records the working tree's `paths` as a commit on the checked-out branch. */
  private commit(project: ProjectState, summary: string, paths: string[], at: number, description = "") {
    const files = paths.flatMap((path) => {
      const patch = this.patchFor(project, path)
      return patch ? [{ path, additions: patch.additions, deletions: patch.deletions }] : []
    })
    for (const path of paths) {
      const content = project.files.get(path)
      if (content === undefined) project.head.delete(path)
      else project.head.set(path, content)
    }
    const sha = hashString(`${project.seed.id}:${project.history.length}:${summary}`).padStart(8, "0").repeat(5)
    project.history.unshift({
      sha,
      summary,
      description,
      authorName: "You",
      authoredAt: new Date(at).toISOString(),
      tags: [],
      ...(project.seed.localOnly ? {} : { githubUrl: `https://github.com/${project.seed.repoOwner}/${project.seed.title}/commit/${sha}` }),
      files: files.length > 0 ? files : paths.map((path) => ({ path, additions: (project.files.get(path) ?? "").split("\n").length - 1, deletions: 0 })),
    })
  }

  /** Starts the turns that were mid-stream when the demo "opened". */
  start() {
    if (this.started) return
    this.started = true
    for (const chat of this.chats.values()) {
      if (chat.turn && !chat.turn.question) this.scheduleNextStep(chat)
    }
  }

  dispose() {
    for (const chat of this.chats.values()) {
      if (chat.turn?.timer != null) this.clock.clearTimeout(chat.turn.timer)
    }
  }

  /** Where a project lives, for the upload route in environment.ts. Null for an unknown id. */
  projectLocalPath(projectId: string) {
    return this.projects.get(projectId)?.seed.localPath ?? null
  }

  receive(envelope: ClientEnvelope) {
    if (envelope.type === "subscribe") {
      this.subscriptions.set(envelope.id, envelope.topic)
      this.lastSent.delete(envelope.id)
      this.windowStarts.delete(envelope.id)
      if (envelope.topic.type === "terminal") {
        this.sendTerminalSnapshot(envelope.id, envelope.topic.terminalId)
      } else {
        this.publishTo(envelope.id, envelope.topic)
      }
      return
    }
    if (envelope.type === "unsubscribe") {
      this.subscriptions.delete(envelope.id)
      this.lastSent.delete(envelope.id)
      this.windowStarts.delete(envelope.id)
      return
    }
    try {
      const result = this.handleCommand(envelope.command)
      this.send({ v: 1, type: "ack", id: envelope.id, result })
    } catch (error) {
      this.send({ v: 1, type: "error", id: envelope.id, message: error instanceof Error ? error.message : String(error) })
    }
    this.publish()
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  private seedChat(seed: DemoChatSeed) {
    const project = this.projects.get(seed.projectId)!
    const endAt = this.clock.now() - seed.minutesAgo * 60_000
    const lastTurn = seed.turns.at(-1)!
    const playedSteps = (turnIndex: number) => {
      const turn = seed.turns[turnIndex]!
      return turn === lastTurn && seed.liveFromStep != null ? turn.steps.slice(0, seed.liveFromStep) : turn.steps
    }
    const totalMs = seed.turns.reduce((total, _turn, index) => (
      total + playedSteps(index).reduce((sum, step) => sum + step.delayMs, 0) + 45_000
    ), 0)

    const chat: ChatState = {
      id: seed.id,
      projectId: seed.projectId,
      title: seed.title,
      provider: lastTurn.provider,
      model: lastTurn.model,
      createdAt: endAt - totalMs,
      turnCount: 0,
      unread: false,
      entries: [],
      queued: [],
      turn: null,
      touchedPaths: new Set(),
      planMode: false,
      tasks: (seed.tasks ?? []).map((task): SubagentActivity => ({
        id: task.id,
        type: task.type,
        label: task.label,
        status: task.status,
        startedAt: this.clock.now() - task.startedMinutesAgo * 60_000,
        ...(task.endedMinutesAgo !== undefined ? { endedAt: this.clock.now() - task.endedMinutesAgo * 60_000 } : {}),
        ...(task.description ? { description: task.description } : {}),
        ...(task.usage ? { usage: task.usage } : {}),
        ...(task.status === "running" ? { stoppable: true } : {}),
      })),
      schedules: (seed.schedules ?? []).map((schedule): ChatSchedule => {
        const createdAt = this.clock.now() - schedule.createdMinutesAgo * 60_000
        return {
          id: schedule.id,
          name: schedule.name,
          content: schedule.content,
          target: { kind: "chat", chatId: seed.id },
          trigger: { kind: "interval", everyMs: schedule.everyMinutes * 60_000 },
          enabled: true,
          createdAt,
          updatedAt: createdAt,
          createdByChatId: seed.id,
          nextRunAt: createdAt + schedule.everyMinutes * 60_000,
          runCount: 0,
        }
      }),
    }
    this.chats.set(chat.id, chat)

    let at = chat.createdAt
    seed.turns.forEach((turn, turnIndex) => {
      at += 45_000
      this.appendEntry(chat, { kind: "user_prompt", content: turn.prompt, attachments: [] }, at)
      chat.lastTurnStartedAt = at
      const steps = playedSteps(turnIndex)
      for (const step of steps) {
        at += step.delayMs
        this.applyStep(chat, step, at)
        if (step.question) {
          chat.turn = { steps: [...turn.steps], index: turn.steps.indexOf(step) + 1, timer: null, question: step.question }
          return
        }
      }
      if (steps.length < turn.steps.length) {
        chat.turn = { steps: [...turn.steps], index: steps.length, timer: null, question: null }
        return
      }
      chat.turnCount += 1
      chat.lastTurnEndedAt = at
    })
    chat.unread = seed.unread ?? false
    if (seed.commitAfter) this.commit(project, seed.title, this.changedPaths(project), at)
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private nextId(prefix: string) {
    this.idCounter += 1
    return `${prefix}-${this.idCounter}`
  }

  private appendEntry(chat: ChatState, draft: EntryDraft, at: number) {
    const entry = { ...draft, _id: this.nextId("entry"), createdAt: at } as TranscriptEntry
    chat.entries.push(entry)
    chat.lastMessageAt = at
    if (entry.kind === "assistant_text" || entry.kind === "tool_call" || entry.kind === "tool_result") {
      chat.lastAgentMessageAt = at
    }
  }

  private applyStep(chat: ChatState, step: DemoStep, at: number) {
    for (const entry of step.entries) this.appendEntry(chat, entry, at)
    const project = this.projects.get(chat.projectId)!
    for (const write of step.writes ?? []) {
      chat.touchedPaths.add(write.path)
      const next = write.apply(project.files.get(write.path) ?? null)
      if (next === null) project.files.delete(write.path)
      else project.files.set(write.path, next)
    }
  }

  private startTurn(chat: ChatState, message: OutgoingMessage) {
    const provider = message.provider ?? chat.provider ?? "claude"
    const model = message.model ?? (provider === chat.provider && chat.model ? chat.model : defaultModelFor(provider))
    const project = this.projects.get(chat.projectId)!
    const now = this.clock.now()

    this.appendEntry(chat, { kind: "user_prompt", content: message.content, attachments: message.attachments }, now)
    chat.provider = provider
    chat.model = model
    chat.lastTurnStartedAt = now
    chat.doneAt = undefined
    chat.planMode = message.planMode ?? false

    const turn = composeScriptedReply({
      prompt: message.content,
      provider,
      model,
      project: project.seed,
      files: project.files,
      gitStatusAfterPlan: this.gitStatusShort(project, "PLAN.md"),
      firstTurn: !chat.entries.some((entry) => entry.kind === "system_init"),
      planMode: chat.planMode,
    })
    chat.turn = { steps: turn.steps, index: 0, timer: null, question: null }
    this.scheduleNextStep(chat)
  }

  private scheduleNextStep(chat: ChatState) {
    const turn = chat.turn
    if (!turn) return
    if (turn.index >= turn.steps.length) {
      this.finishTurn(chat)
      return
    }
    const step = turn.steps[turn.index]!
    turn.timer = this.clock.setTimeout(() => {
      if (chat.turn !== turn) return
      turn.timer = null
      turn.index += 1
      this.applyStep(chat, step, this.clock.now())
      if (step.question) {
        turn.question = step.question
        this.publish()
        return
      }
      this.scheduleNextStep(chat)
      this.publish()
    }, step.delayMs)
  }

  private finishTurn(chat: ChatState) {
    chat.turn = null
    chat.turnCount += 1
    chat.lastTurnEndedAt = this.clock.now()
    chat.unread = true
    const next = chat.queued.shift()
    if (next) this.startTurn(chat, next)
  }

  private cancelTurn(chat: ChatState) {
    const turn = chat.turn
    if (!turn) return
    if (turn.timer != null) this.clock.clearTimeout(turn.timer)
    chat.turn = null
    this.appendEntry(chat, { kind: "interrupted" }, this.clock.now())
    chat.lastTurnEndedAt = this.clock.now()
  }

  private respondToQuestion(chat: ChatState, toolUseId: string, result: unknown) {
    const turn = chat.turn
    const question = turn?.question
    if (!turn || !question || question.toolId !== toolUseId) throw new Error("No pending tool request")
    let answer: string
    let content: string
    if (question.kind === "exit_plan_mode") {
      const response = (result ?? {}) as { confirmed?: boolean; message?: string }
      answer = response.confirmed ? "approved" : "rejected"
      content = response.confirmed
        ? "User approved the plan."
        : response.message ? `User sent the plan back: ${response.message}` : "User sent the plan back."
      if (response.confirmed) chat.planMode = false
    } else {
      const answers = (result as { answers?: Record<string, string[]> } | null)?.answers ?? {}
      answer = Object.values(answers).flat()[0] ?? ""
      content = answer ? `User answered: ${answer}` : "User answered."
    }
    this.appendEntry(chat, {
      kind: "tool_result",
      toolId: toolUseId,
      content,
      structuredResult: result,
    }, this.clock.now())
    turn.question = null
    turn.steps.splice(turn.index, 0, ...question.continueWith(answer))
    this.scheduleNextStep(chat)
  }

  private chatStatus(chat: ChatState): KannaStatus {
    if (!chat.turn) return "idle"
    return chat.turn.question ? "waiting_for_user" : "running"
  }

  /** `chatId`: the client names a chat it creates, and opens it before the ack. */
  private createChat(projectId: string, chatId?: string) {
    if (!this.projects.has(projectId)) throw new Error("Unknown project")
    if (chatId && this.chats.has(chatId)) throw new Error("Chat already exists")
    const chat: ChatState = {
      id: chatId ?? this.nextId("demo-chat"),
      projectId,
      // The server's own placeholder, word for word: the client shows a
      // fresh chat's empty state only while its title is still "New Chat".
      title: "New Chat",
      provider: null,
      model: null,
      createdAt: this.clock.now(),
      turnCount: 0,
      unread: false,
      entries: [],
      queued: [],
      turn: null,
      touchedPaths: new Set(),
      planMode: false,
      tasks: [],
      schedules: [],
    }
    this.chats.set(chat.id, chat)
    return chat
  }

  private requireChat(chatId: string) {
    const chat = this.chats.get(chatId)
    if (!chat) throw new Error("Chat not found")
    return chat
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private handleCommand(command: ClientCommand): unknown {
    switch (command.type) {
      case "system.ping":
        return null

      case "chat.send": {
        let chat = command.chatId ? this.requireChat(command.chatId) : null
        if (!chat) {
          if (!command.projectId) throw new Error("Open a project first")
          chat = this.createChat(command.projectId)
        }
        if (chat.entries.length === 0) chat.title = titleFromPrompt(command.content)
        if (command.delegator && !command.chatId) chat.delegator = true
        const message: OutgoingMessage = {
          content: command.content,
          attachments: command.attachments ?? [],
          provider: command.provider,
          model: command.model,
          planMode: command.planMode,
        }
        if (chat.turn) chat.queued.push(this.toQueued(message))
        else this.startTurn(chat, message)
        return { chatId: chat.id }
      }
      case "chat.create": {
        const chat = this.createChat(command.projectId, command.chatId)
        if (command.delegator) chat.delegator = true
        return { chatId: chat.id }
      }
      case "chat.setDelegator":
        this.requireChat(command.chatId).delegator = command.delegator || undefined
        return null
      case "message.enqueue": {
        const chat = this.requireChat(command.chatId)
        const message: OutgoingMessage = {
          content: command.content,
          attachments: command.attachments ?? [],
          provider: command.provider,
          model: command.model,
          planMode: command.planMode,
        }
        if (!chat.turn) {
          this.startTurn(chat, message)
          return { queuedMessageId: null }
        }
        if (command.steer) {
          this.cancelTurn(chat)
          this.startTurn(chat, message)
          return { queuedMessageId: null }
        }
        const queued = this.toQueued(message)
        chat.queued.push(queued)
        return { queuedMessageId: queued.id }
      }
      case "message.dequeue": {
        const chat = this.requireChat(command.chatId)
        chat.queued = chat.queued.filter((message) => message.id !== command.queuedMessageId)
        return null
      }
      case "message.steer": {
        const chat = this.requireChat(command.chatId)
        const queued = chat.queued.find((message) => message.id === command.queuedMessageId)
        if (!queued) return null
        chat.queued = chat.queued.filter((message) => message !== queued)
        this.cancelTurn(chat)
        this.startTurn(chat, queued)
        return null
      }
      case "chat.stopTask": {
        const task = this.requireChat(command.chatId).tasks.find((entry) => entry.id === command.taskId)
        if (!task) throw new Error("Task not found")
        if (task.status === "running") {
          task.status = "stopped"
          task.endedAt = this.clock.now()
          delete task.stoppable
        }
        return null
      }
      case "chat.cancel":
      case "chat.stopDraining":
        this.cancelTurn(this.requireChat(command.chatId))
        return null
      case "chat.respondTool":
        this.respondToQuestion(this.requireChat(command.chatId), command.toolUseId, command.result)
        return null

      case "chat.markRead":
        this.requireChat(command.chatId).unread = false
        return null
      case "chat.setDone": {
        const chat = this.requireChat(command.chatId)
        chat.doneAt = command.done ? this.clock.now() : undefined
        return null
      }
      case "chat.rename":
        this.requireChat(command.chatId).title = command.title
        return null
      case "chat.setPinned": {
        const chat = this.requireChat(command.chatId)
        chat.pinnedAt = command.pinned ? this.clock.now() : undefined
        return null
      }
      case "chat.archive": {
        const chat = this.requireChat(command.chatId)
        if (chat.turn) this.cancelTurn(chat)
        chat.archivedAt = this.clock.now()
        return null
      }
      case "chat.unarchive":
        this.requireChat(command.chatId).archivedAt = undefined
        return null
      case "chat.delete": {
        const chat = this.requireChat(command.chatId)
        if (chat.turn?.timer != null) this.clock.clearTimeout(chat.turn.timer)
        this.chats.delete(chat.id)
        return null
      }
      case "chat.fork": {
        const source = this.requireChat(command.chatId)
        const fork = this.createChat(source.projectId)
        fork.title = `${source.title} (fork)`
        fork.provider = source.provider
        fork.model = source.model
        fork.entries = source.entries.map((entry) => ({ ...entry, _id: this.nextId("entry") }))
        fork.lastMessageAt = this.clock.now()
        fork.turnCount = source.turnCount
        fork.touchedPaths = new Set(source.touchedPaths)
        return { chatId: fork.id }
      }

      case "chat.getPreview":
        return this.chatPreview(this.requireChat(command.chatId))
      case "chat.touchedFiles":
        return this.touchedFiles(this.requireChat(command.chatId))
      case "chat.getToolEntries": {
        const chat = this.requireChat(command.chatId)
        const wanted = new Set(command.entryIds)
        return chat.entries.filter((entry) => wanted.has(entry._id))
      }
      case "chat.loadOlder":
        return this.loadOlder(this.requireChat(command.chatId), command)
      case "chat.getReadAnchor":
        return null
      case "chat.setReadAnchor":
      case "chat.setDraftProtection":
      case "chat.refreshDiffs":
        return null
      // A project made in the demo has no GitHub remote; GitHub's CLI isn't
      // signed in (see createProviderAuth), so publishing stops at sign-in.
      case "chat.getGitHubPublishInfo": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        return {
          ghInstalled: true,
          authenticated: false,
          owners: [],
          suggestedRepoName: project.seed.localPath.split("/").filter(Boolean).at(-1) ?? "my-repo",
        } satisfies GitHubPublishInfo
      }
      case "chat.checkGitHubRepoAvailability":
        return { available: false, message: "GitHub CLI is not authenticated." } satisfies GitHubRepoAvailabilityResult
      case "chat.listSkills":
        return { provider: command.provider, skills: demoSkills(command.provider, this.globalSkills), origin: "filesystem" } satisfies ChatSkillsSnapshot
      case "chat.getEntryDebugRaw":
        return null
      case "chat.exportStandalone":
        return this.exportStandalone(this.requireChat(command.chatId))

      case "project.readDiffPatch": {
        const project = this.requireProject(command.projectId)
        return { patch: this.patchFor(project, command.path)?.patch ?? "" }
      }
      case "project.generateCommitMessage":
        return {
          subject: "Add height units, deploys and docs",
          body: "Written by the Kanna demo. A real install drafts this from the diff.",
        }
      case "project.commitDiffs": {
        const project = this.requireProject(command.projectId)
        this.commit(project, command.summary, command.paths, this.clock.now(), command.description ?? "")
        return { ok: true, mode: command.mode, pushed: command.mode === "commit_and_push", snapshotChanged: true }
      }
      case "project.readCommit": {
        const project = this.requireProject(command.projectId)
        const commit = project.history.find((entry) => entry.sha === command.sha)
        if (!commit) throw new Error("Commit not found")
        return {
          sha: commit.sha,
          authorEmail: "you@example.com",
          committedAt: commit.authoredAt,
          parentCount: commit === project.history.at(-1) ? 0 : 1,
          files: commit.files,
          totalFileCount: commit.files.length,
          additions: commit.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: commit.files.reduce((sum, file) => sum + file.deletions, 0),
        } satisfies ChatCommitDetails
      }
      case "project.readBranch": {
        const project = this.requireProject(command.projectId)
        const tip = project.history[0]
        return {
          ...(tip ? { lastCommit: { sha: tip.sha, summary: tip.summary, authorName: tip.authorName, authoredAt: tip.authoredAt } } : {}),
          ...(command.branch.name === "main" ? {} : { base: { name: "main", ahead: 0, behind: 0 } }),
          ...(command.branch.kind === "local" ? { upstream: { name: `origin/${command.branch.name}`, ahead: 0, behind: 0, gone: false } } : {}),
        } satisfies ChatBranchDetails
      }
      case "project.rename": {
        const project = "projectId" in command
          ? this.requireProject(command.projectId)
          : this.projectAt(command.localPath)
        project.title = command.title
        return null
      }
      case "project.remove": {
        const project = "projectId" in command
          ? this.requireProject(command.projectId)
          : this.projectAt(command.localPath)
        project.hidden = true
        return null
      }
      case "project.create": {
        const existing = [...this.projects.values()].find((candidate) => candidate.seed.localPath === command.localPath)
        if (existing) {
          existing.hidden = false
          return { projectId: existing.seed.id }
        }
        const name = command.localPath.split("/").filter(Boolean).at(-1) ?? "project"
        const project = this.addProject({
          id: this.nextId("demo-project"),
          title: command.title ?? name,
          localPath: command.localPath,
          repoOwner: "you",
          branchName: "main",
          entryFile: "README.md",
          files: { "README.md": `# ${command.title ?? name}\n` },
          localOnly: true,
        })
        return { projectId: project.seed.id }
      }
      case "project.writeQuickActions":
        this.requireProject(command.projectId).quickActions = command.quickActions
        return command.quickActions
      case "project.setPinned": {
        const project = this.projects.get(command.projectId)
        if (!project) throw new Error("Project not found")
        project.pinnedAt = command.pinned ? command.pinnedAt ?? this.clock.now() : undefined
        return null
      }
      case "project.open": {
        const project = [...this.projects.values()].find((candidate) => candidate.seed.localPath === command.localPath)
        if (!project) throw new Error(DEMO_UNAVAILABLE_MESSAGE)
        project.hidden = false
        return { projectId: project.seed.id }
      }
      case "chat.discardDiffFile": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        const committed = project.head.get(command.path)
        if (committed === undefined) project.files.delete(command.path)
        else project.files.set(command.path, committed)
        return { ok: true, snapshotChanged: true }
      }
      case "chat.listBranches": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        const local = project.branches.map((name): ChatBranchListEntry => ({ id: `local:${name}`, kind: "local", name, displayName: name }))
        return {
          currentBranchName: project.branchName,
          defaultBranchName: "main",
          recent: local,
          local,
          remote: [],
          pullRequests: [],
          pullRequestsStatus: "unavailable",
        } satisfies ChatBranchListResult
      }
      case "chat.checkoutBranch": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        if (!project.branches.includes(command.branch.name)) {
          return { ok: false, title: "Checkout failed", message: `There is no branch named ${command.branch.name}.` }
        }
        project.branchName = command.branch.name
        return { ok: true, branchName: project.branchName, snapshotChanged: true }
      }
      case "chat.createBranch": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        const name = command.name.trim()
        if (project.branches.includes(name)) {
          return { ok: false, title: "Create branch failed", message: `A branch named ${name} already exists.` }
        }
        project.branches.push(name)
        project.branchName = name
        return { ok: true, branchName: name, snapshotChanged: true }
      }
      case "chat.syncBranch":
        this.requireChat(command.chatId)
        return { ok: true, action: command.action, aheadCount: 0, behindCount: 0, snapshotChanged: false }
      case "chat.previewMergeBranch": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        // Branches in the demo share their history; another one is a commit ahead.
        const behind = command.branch.name !== project.branchName
        return {
          currentBranchName: project.branchName,
          targetBranchName: command.branch.name,
          targetDisplayName: command.branch.name,
          status: behind ? "mergeable" : "up_to_date",
          commitCount: behind ? 1 : 0,
          hasConflicts: false,
          message: behind
            ? `1 commit from ${command.branch.name} merges cleanly into ${project.branchName}.`
            : `${project.branchName} already has everything in ${command.branch.name}.`,
        } satisfies ChatMergePreviewResult
      }
      case "chat.mergeBranch":
        this.requireChat(command.chatId)
        return { ok: true, branchName: command.branch.name, snapshotChanged: true }
      case "chat.ignoreDiffFile": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        const gitignore = project.files.get(".gitignore") ?? ""
        project.files.set(".gitignore", `${gitignore}${command.path}\n`)
        project.files.delete(command.path)
        return { ok: true, snapshotChanged: true }
      }
      case "project.readQuickActions":
        return this.requireProject(command.projectId).quickActions
      // The home page and the command palette list these; the demo has no gh.
      case "github.listRecentRepos":
        return { available: false, repos: [] } satisfies GitHubRecentReposResult
      case "sidebar.reorderProjectGroups":
        return null

      case "settings.readAppSettings":
        return this.appSettings
      case "settings.writeAppSettingsPatch":
        this.appSettings = mergeAppSettingsPatch(this.appSettings, command.patch)
        return this.appSettings
      case "settings.readKeybindings":
        return this.keybindings
      case "settings.writeKeybindings":
        this.keybindings = { ...this.keybindings, bindings: { ...this.keybindings.bindings, ...command.bindings } as Record<KeybindingAction, string[]> }
        return this.keybindings
      case "settings.readLlmProvider":
        return this.llmProvider
      case "settings.writeLlmProvider":
        this.llmProvider = {
          ...this.llmProvider,
          provider: command.provider,
          apiKey: command.apiKey,
          model: command.model,
          baseUrl: command.baseUrl,
          ...(command.faveModels ? { faveModels: command.faveModels } : {}),
          enabled: command.apiKey.trim().length > 0,
        }
        return this.llmProvider
      case "settings.validateLlmProvider":
        return command.apiKey.trim()
          ? { ok: true, error: null }
          : { ok: false, error: "Add an API key first." }
      case "usage.refresh":
        return createUsageLimits(this.clock.now())
      case "auth.refresh":
        return this.providerAuth()

      case "accounts.create":
        return { accountId: this.createAccount(command.account).id }
      case "accounts.setDefault":
        this.requireAccount(command.accountId)
        this.defaultAccountIds = { ...this.defaultAccountIds, [command.provider]: command.accountId }
        return null
      case "accounts.updateKey":
        this.requireAccount(command.accountId)
        return null
      case "accounts.rename":
        this.requireAccount(command.accountId).label = command.label
        return null
      case "accounts.remove": {
        const account = this.requireAccount(command.accountId)
        this.accounts = this.accounts.filter((entry) => entry !== account)
        if (this.defaultAccountIds[account.provider] === account.id) {
          this.defaultAccountIds = { ...this.defaultAccountIds, [account.provider]: existingAccountId(account.provider) }
        }
        return null
      }
      // A browser can't run a provider's CLI or open an app on the visitor's
      // computer: these say so, on purpose.
      case "accounts.login":
      case "auth.login.start":
      case "auth.install":
      case "system.openExternal":
      case "update.install":
      case "update.installNightly":
      case "update.installStable":
        throw new Error(DEMO_NEEDS_MACHINE_MESSAGE)

      case "mcp.read":
        return this.mcpSnapshot()
      case "mcp.save":
        this.saveMcpServer(command.server)
        return this.mcpSnapshot()
      case "mcp.remove":
        this.mcpServers = this.mcpServers.filter((server) => server.id !== command.id)
        this.mcpRevision += 1
        return this.mcpSnapshot()
      case "mcp.connect": {
        const server = this.requireMcpServer(command.id)
        server.status = "connected"
        server.toolCount = server.toolCount ?? 12
        this.mcpRevision += 1
        return { status: server.status }
      }
      case "mcp.disconnect": {
        const server = this.requireMcpServer(command.id)
        server.status = "unconnected"
        delete server.toolCount
        this.mcpRevision += 1
        return this.mcpSnapshot()
      }
      case "mcp.importProvider":
      case "mcp.importConfig":
        this.saveMcpServer({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp", providers: ["claude", "codex", "cursor", "pi"] })
        return this.mcpSnapshot()

      case "skills.search": {
        const query = command.query.trim().toLowerCase()
        const skills = SKILL_CATALOG.filter((skill) => skill.name.includes(query) || skill.source.includes(query)).slice(0, command.limit ?? 20)
        return { query: command.query, searchType: "fuzzy", skills, count: skills.length, duration_ms: 42 }
      }
      case "skills.install": {
        const found = SKILL_CATALOG.find((skill) => skill.skillId === command.skillId)
        if (found && !this.globalSkills.some((skill) => skill.name === found.name)) {
          this.globalSkills = [...this.globalSkills, {
            name: found.name,
            description: `Installed from ${found.source}.`,
            providers: ["claude", "codex", "cursor", "grok", "pi"],
            paths: [`${DEMO_HOME}/.agents/skills/${found.name}/SKILL.md`],
            source: found.source,
          }]
        }
        return { source: command.source, skillId: command.skillId, command: ["npx", "skills", "add", command.source], cwd: DEMO_HOME, stdout: "", stderr: "" }
      }
      case "skills.uninstall":
        this.globalSkills = this.globalSkills.filter((skill) => skill.name !== command.skillId)
        return { skillId: command.skillId, command: ["npx", "skills", "remove", command.skillId], cwd: DEMO_HOME, stdout: "", stderr: "" }

      case "fs.list":
        return this.listDirectory(command.path, command.nearest ?? false)
      case "update.check":
        return createUpdate(this.clock.now())

      case "browser.listLocalHttpServers":
        return []
      case "skills.listInstalled":
        return { lockFilePath: `${DEMO_HOME}/.agents/.skill-lock.json`, skills: [] }
      case "skills.listGlobal":
        return { skills: this.globalSkills }

      case "terminal.create":
        return this.createShell(command.terminalId, command.projectId, command.cols, command.rows)
      case "terminal.input":
        this.shells.get(command.terminalId)?.input(command.data)
        return null
      case "terminal.resize":
        this.shells.get(command.terminalId)?.resize(command.cols, command.rows)
        return null
      case "terminal.close":
        this.shells.delete(command.terminalId)
        return null
      case "terminal.tail": {
        const shell = this.shells.get(command.terminalId)
        if (!shell) return null
        const tail = shell.tail(command.sinceVersion)
        return { terminalId: shell.terminalId, tail, snapshot: tail ? null : shell.snapshot() } satisfies TerminalTailResult
      }
    }
    throw new Error(DEMO_UNAVAILABLE_MESSAGE)
  }

  private toQueued(message: OutgoingMessage): QueuedChatMessage {
    return {
      id: this.nextId("queued"),
      content: message.content,
      attachments: message.attachments,
      createdAt: this.clock.now(),
      provider: message.provider,
      model: message.model,
    }
  }

  private uncommittedTouchedPaths(chat: ChatState) {
    const project = this.projects.get(chat.projectId)!
    return [...chat.touchedPaths].filter((path) => project.files.get(path) !== project.head.get(path))
  }

  private touchedFiles(chat: ChatState): ChatTouchedFilesResult {
    const project = this.projects.get(chat.projectId)!
    const files = this.uncommittedTouchedPaths(chat).flatMap((path) => {
      const patch = this.patchFor(project, path)
      return patch ? [{ path, additions: patch.additions, deletions: patch.deletions }] : []
    })
    return { files, totalCount: files.length }
  }

  private requireProject(projectId: string) {
    const project = this.projects.get(projectId)
    if (!project) throw new Error("Unknown project")
    return project
  }

  private chatPreview(chat: ChatState): ChatPreview {
    const newestFirst = [...chat.entries].reverse()
    const lastUser = newestFirst.find((entry) => entry.kind === "user_prompt")
    const lastAgent = newestFirst.find((entry) => entry.kind === "assistant_text")
    return {
      ...(lastUser?.kind === "user_prompt" ? { lastUserMessagePreview: lastUser.content.slice(0, 280) } : {}),
      ...(lastAgent?.kind === "assistant_text"
        ? { lastAgentMessagePreview: lastAgent.text.slice(0, 280), lastAgentMessagePreviewAt: lastAgent.createdAt }
        : {}),
    }
  }

  private projectAt(localPath: string) {
    const project = [...this.projects.values()].find((candidate) => candidate.seed.localPath === localPath)
    if (!project) throw new Error("Project not found")
    return project
  }

  /**
   * Sharing uploads a page to kanna.sh, which the demo can't do; it fails the
   * way a real share does, with the transcript offered as a download.
   */
  private exportStandalone(chat: ChatState): StandaloneTranscriptExportFailureResult {
    const slug = chat.id
    return {
      ok: false,
      error: "Sharing needs Kanna running on your own machine. You can still download this chat's transcript.",
      outputDir: "",
      transcriptJsonPath: "",
      transcriptFileName: `${slug}.json`,
      transcriptJson: JSON.stringify({ title: chat.title, messages: chat.entries }, null, 2),
      shareSlug: slug,
      shareUrl: "",
    }
  }

  // -------------------------------------------------------------------------
  // Accounts, MCP servers, files
  // -------------------------------------------------------------------------

  private providerAuth(): ProviderAuthSnapshot {
    return { ...createProviderAuth(), accounts: this.accounts, defaultAccountIds: this.defaultAccountIds }
  }

  private createAccount(input: AccountInput) {
    const keyed = input.provider === "cursor" || input.provider === "pi"
    const account: ProviderAccount = {
      id: this.nextId("account"),
      provider: input.provider,
      label: input.label.trim() || "Account",
      mode: keyed ? "apiKey" : "native",
      identity: null,
      authStatus: keyed ? "signed_in" : "signed_out",
      login: { phase: "idle" },
      statusDetail: null,
    }
    this.accounts = [...this.accounts, account]
    return account
  }

  private requireAccount(accountId: string) {
    const account = this.accounts.find((entry) => entry.id === accountId)
    if (!account) throw new Error("Account not found")
    return account
  }

  private mcpSnapshot(): McpSnapshot {
    return { servers: this.mcpServers.map((server) => ({ ...server })), filePath: "~/.kanna/mcp.json", revision: this.mcpRevision }
  }

  private requireMcpServer(id: string) {
    const server = this.mcpServers.find((entry) => entry.id === id)
    if (!server) throw new Error("MCP server not found")
    return server
  }

  private saveMcpServer(input: McpServerInput) {
    const existing = input.id ? this.mcpServers.find((server) => server.id === input.id) : undefined
    const summary: McpServerSummary = {
      id: existing?.id ?? this.nextId("mcp"),
      name: input.name,
      transport: input.transport,
      ...(input.command ? { command: input.command } : {}),
      ...(input.url ? { url: input.url } : {}),
      providers: input.providers,
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      argumentCount: input.args?.length ?? existing?.argumentCount ?? 0,
      environmentKeys: input.env ? Object.keys(input.env) : existing?.environmentKeys ?? [],
      headerKeys: input.headers ? Object.keys(input.headers) : existing?.headerKeys ?? [],
      hasClientSecret: Boolean(input.clientSecret) || (existing?.hasClientSecret ?? false),
      status: existing?.status ?? "unconnected",
      ...(existing?.toolCount !== undefined ? { toolCount: existing.toolCount } : {}),
    }
    this.mcpServers = existing
      ? this.mcpServers.map((server) => (server === existing ? summary : server))
      : [...this.mcpServers, summary]
    this.mcpRevision += 1
  }

  /**
   * The visitor's home as the folder browser sees it: ~/Projects holds the
   * demo projects and their files, ~/Kanna is where new projects go.
   */
  private listDirectory(requested: string | undefined, nearest: boolean): FsListResult {
    const home = DEMO_HOME
    const expand = (path: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)
    const normalize = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path)
    const dirs = new Map<string, Map<string, "dir" | "file">>()
    const add = (path: string, kind: "dir" | "file") => {
      const parts = path.split("/").filter(Boolean)
      for (let index = 0; index < parts.length; index += 1) {
        const parent = `/${parts.slice(0, index).join("/")}`
        const entries = dirs.get(parent) ?? new Map<string, "dir" | "file">()
        dirs.set(parent, entries)
        const isLast = index === parts.length - 1
        if (!entries.has(parts[index]!) || !isLast || kind === "dir") entries.set(parts[index]!, isLast ? kind : "dir")
      }
      if (kind === "dir" && !dirs.has(path)) dirs.set(path, new Map())
    }
    for (const name of ["Desktop", "Documents", "Downloads", "Kanna", "Projects"]) add(`${home}/${name}`, "dir")
    for (const project of this.projects.values()) {
      add(project.seed.localPath, "dir")
      add(`${project.seed.localPath}/.git`, "dir")
      for (const path of project.files.keys()) add(`${project.seed.localPath}/${path}`, "file")
    }

    let path = normalize(expand(requested?.trim() || home))
    let missingSuffix: string | undefined
    if (!dirs.has(path)) {
      if (!nearest) throw new Error(`No such folder: ${requested}`)
      const parts = path.split("/").filter(Boolean)
      let found = "/"
      for (let index = parts.length; index >= 0; index -= 1) {
        const candidate = `/${parts.slice(0, index).join("/")}`
        if (dirs.has(candidate)) {
          found = candidate
          missingSuffix = parts.slice(index).join("/")
          break
        }
      }
      path = found
    }
    const entries = [...(dirs.get(path) ?? new Map()).entries()]
      .filter(([name]) => name !== ".git")
      .map(([name, kind]) => ({ name, kind }))
      .sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) : left.kind === "dir" ? -1 : 1))
    const parts = path.split("/").filter(Boolean)
    return {
      path,
      parentPath: parts.length === 0 ? null : `/${parts.slice(0, -1).join("/")}`,
      homePath: home,
      isGitRepo: dirs.get(path)?.has(".git") ?? false,
      entries,
      truncated: false,
      ...(missingSuffix ? { missingSuffix } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Terminal
  // -------------------------------------------------------------------------

  private createShell(terminalId: string, projectId: string | null, cols: number, rows: number) {
    const existing = this.shells.get(terminalId)
    if (existing) return existing.snapshot()
    const project = (projectId ? this.projects.get(projectId) : null) ?? this.projects.values().next().value!
    const shell = new DemoShell(terminalId, {
      displayPath: project.seed.localPath.replace(DEMO_HOME, "~"),
      absolutePath: project.seed.localPath,
      branchName: project.seed.branchName,
      listFiles: () => [...project.files.keys()],
      readFile: (path) => project.files.get(path) ?? null,
      gitStatus: () => this.gitStatusShort(project),
    }, (data, version) => {
      for (const [id, topic] of this.subscriptions) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        this.send({ v: 1, type: "event", id, event: { type: "terminal.output", terminalId, data, version } })
      }
    }, cols, rows)
    this.shells.set(terminalId, shell)
    for (const [id, topic] of this.subscriptions) {
      if (topic.type === "terminal" && topic.terminalId === terminalId) this.sendTerminalSnapshot(id, terminalId)
    }
    return shell.snapshot()
  }

  // Terminal snapshots go out on subscribe and create only. Output streams as
  // events; re-sending the snapshot per keystroke would make the pane reset
  // and replay its whole buffer each time.
  private sendTerminalSnapshot(subscriptionId: string, terminalId: string) {
    const data = this.shells.get(terminalId)?.snapshot() ?? null
    this.send({ v: 1, type: "snapshot", id: subscriptionId, snapshot: { type: "terminal", data } })
  }

  // -------------------------------------------------------------------------
  // Git
  // -------------------------------------------------------------------------

  private changedPaths(project: ProjectState) {
    const paths = new Set([...project.files.keys(), ...project.head.keys()])
    return [...paths]
      .filter((path) => project.files.get(path) !== project.head.get(path))
      .sort()
  }

  private gitStatusShort(project: ProjectState, alsoAdded?: string) {
    const paths = new Set(this.changedPaths(project))
    if (alsoAdded && !project.head.has(alsoAdded)) paths.add(alsoAdded)
    return [...paths].sort().map((path) => `${statusLetter(project, path)} ${path}`).join("\n")
  }

  private patchFor(project: ProjectState, path: string) {
    const before = project.head.get(path)
    const after = project.files.get(path)
    if (before === after) return null
    const changeType: ChatDiffFile["changeType"] = before === undefined ? "added" : after === undefined ? "deleted" : "modified"
    return { changeType, ...createUnifiedPatch(path, before ?? "", after ?? "", changeType) }
  }

  private projectGitSnapshot(projectId: string): ChatDiffSnapshot | null {
    const project = this.projects.get(projectId)
    if (!project) return null
    const files = this.changedPaths(project).flatMap((path): ChatDiffFile[] => {
      const patch = this.patchFor(project, path)
      if (!patch) return []
      return [{
        path,
        changeType: patch.changeType,
        isUntracked: patch.changeType === "added",
        additions: patch.additions,
        deletions: patch.deletions,
        patchDigest: hashString(patch.patch),
      }]
    })
    return {
      status: "ready",
      branchName: project.branchName,
      defaultBranchName: "main",
      hasOriginRemote: !project.seed.localOnly,
      ...(project.seed.localOnly ? {} : { originRepoSlug: `${project.seed.repoOwner}/${project.seed.title}` }),
      hasUpstream: !project.seed.localOnly,
      aheadCount: 0,
      behindCount: 0,
      files,
      branchHistory: { entries: project.history.map(({ files: _files, ...entry }) => entry) },
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  private publish() {
    for (const [id, topic] of this.subscriptions) {
      if (topic.type !== "terminal") this.publishTo(id, topic)
    }
  }

  private publishTo(subscriptionId: string, topic: SubscriptionTopic, older?: { before: number }) {
    const snapshot = this.snapshotFor(topic, subscriptionId)
    if (!snapshot) return
    const serialized = JSON.stringify(snapshot)
    if (this.lastSent.get(subscriptionId) === serialized) return
    this.lastSent.set(subscriptionId, serialized)
    // A window widened by `chat.loadOlder` goes out as the older slice alone,
    // which the client lands in front of what it holds, as the real router
    // sends it (toSocketChatSnapshot in ws-router.ts).
    if (older && snapshot.type === "chat" && snapshot.data) {
      const data = snapshot.data
      this.send({
        v: 1,
        type: "snapshot",
        id: subscriptionId,
        snapshot: { type: "chat", data: { ...data, messages: data.messages.slice(0, older.before - data.startIndex), incremental: true } },
      })
      return
    }
    this.send({ v: 1, type: "snapshot", id: subscriptionId, snapshot })
  }

  private snapshotFor(topic: SubscriptionTopic, subscriptionId: string): ServerSnapshot | null {
    switch (topic.type) {
      case "sidebar":
        return { type: "sidebar", data: this.sidebarSnapshot() }
      case "local-projects":
        return { type: "local-projects", data: this.localProjectsSnapshot() }
      case "chat":
        return { type: "chat", data: this.chatSnapshot(topic.chatId, subscriptionId) }
      case "project-git":
        return { type: "project-git", data: this.projectGitSnapshot(topic.projectId) }
      case "app-settings":
        return { type: "app-settings", data: this.appSettings }
      case "keybindings":
        return { type: "keybindings", data: this.keybindings }
      case "update":
        return { type: "update", data: createUpdate(this.clock.now()) }
      case "provider-auth":
        return { type: "provider-auth", data: this.providerAuth() }
      case "usage-limits":
        return { type: "usage-limits", data: createUsageLimits(this.clock.now()) }
      case "terminal":
        return null
    }
  }

  private sidebarRow(chat: ChatState, project: ProjectState): SidebarChatRow {
    const status = this.chatStatus(chat)
    const question = chat.turn?.question
    return {
      _id: chat.id,
      _creationTime: chat.createdAt,
      chatId: chat.id,
      title: chat.title,
      status,
      unread: chat.unread,
      ...(chat.doneAt ? { done: true, doneAt: chat.doneAt } : {}),
      localPath: project.seed.localPath,
      provider: chat.provider,
      ...(chat.model ? { model: chat.model } : {}),
      lastMessageAt: chat.lastMessageAt,
      ...(chat.lastTurnStartedAt != null ? { lastTurnStartedAt: chat.lastTurnStartedAt } : {}),
      ...(chat.lastTurnEndedAt != null ? { lastTurnEndedAt: chat.lastTurnEndedAt } : {}),
      ...(chat.turnCount ? { turnCount: chat.turnCount } : {}),
      ...(chat.lastAgentMessageAt != null ? { lastAgentMessageAt: chat.lastAgentMessageAt } : {}),
      ...(question ? { pendingToolKind: question.kind ?? "ask_user_question", pendingUserInputPreview: question.preview } : {}),
      ...(this.uncommittedTouchedPaths(chat).length > 0 ? { uncommittedWork: true } : {}),
      ...(chat.archivedAt ? { archivedAt: chat.archivedAt } : {}),
      ...(chat.pinnedAt ? { pinnedAt: chat.pinnedAt } : {}),
      ...(chat.delegator ? { delegator: true as const } : {}),
      hasAutomation: false,
      canFork: chat.turnCount > 0 || undefined,
    }
  }

  private sidebarSnapshot(): SidebarData {
    const recency = (chat: ChatState) => Math.max(chat.lastAgentMessageAt ?? 0, chat.lastMessageAt ?? chat.createdAt)
    return {
      projectGroups: [...this.projects.values()].filter((project) => !project.hidden).map((project) => {
        const projectChats = [...this.chats.values()]
          .filter((chat) => chat.projectId === project.seed.id)
          .sort((left, right) => recency(right) - recency(left))
        const chats = projectChats.filter((chat) => !chat.archivedAt).map((chat) => this.sidebarRow(chat, project))
        const archivedChats = projectChats.filter((chat) => chat.archivedAt).map((chat) => this.sidebarRow(chat, project))
        return {
          groupKey: project.seed.id,
          title: project.title,
          realTitle: project.seed.title,
          ...(project.pinnedAt ? { pinnedAt: project.pinnedAt } : {}),
          repoName: project.seed.title,
          hasGitRepo: true,
          branchName: project.branchName,
          repoOwner: project.seed.repoOwner,
          localPath: project.seed.localPath,
          chats,
          previewChats: chats.filter((chat) => !chat.done),
          olderChats: chats.filter((chat) => chat.done),
          ...(archivedChats.length > 0 ? { archivedChats } : {}),
          defaultCollapsed: false,
        }
      }),
    }
  }

  private localProjectsSnapshot(): LocalProjectsSnapshot {
    return {
      machine: { id: "local", displayName: "Your Mac", platform: "darwin" },
      projects: [...this.projects.values()].filter((project) => !project.hidden).map((project) => {
        const projectChats = [...this.chats.values()].filter((chat) => chat.projectId === project.seed.id)
        return {
          localPath: project.seed.localPath,
          title: project.title,
          source: "saved" as const,
          lastOpenedAt: Math.max(...projectChats.map((chat) => chat.lastMessageAt ?? chat.createdAt), 0),
          chatCount: projectChats.length,
        }
      }),
    }
  }

  /**
   * Where a subscription's window starts: on subscribe, the last N assistant
   * messages (the Transcript Window setting), as the real router opens a chat.
   */
  private windowStart(chat: ChatState, subscriptionId: string) {
    let start = this.windowStarts.get(subscriptionId)
    if (start === undefined) {
      start = findTranscriptWindowStart(chat.entries, {
        endExclusive: chat.entries.length,
        assistantMessages: this.appSettings.transcript.windowAssistantMessages,
      })
      this.windowStarts.set(subscriptionId, start)
    }
    return start
  }

  private loadOlder(chat: ChatState, command: Extract<ClientCommand, { type: "chat.loadOlder" }>) {
    let startIndex = 0
    for (const [subscriptionId, topic] of this.subscriptions) {
      if (topic.type !== "chat" || topic.chatId !== chat.id || topic.background) continue
      const current = this.windowStart(chat, subscriptionId)
      const until = command.untilMessageId === undefined
        ? -1
        : chat.entries.findIndex((entry) => entry._id === command.untilMessageId)
      const next = command.all
        ? 0
        : Math.min(current, findTranscriptWindowStart(chat.entries, {
          endExclusive: current,
          assistantMessages: this.appSettings.transcript.windowAssistantMessages,
          ...(until >= 0 ? { mustIncludeIndex: until } : {}),
        }))
      startIndex = next
      if (next === current) continue
      this.windowStarts.set(subscriptionId, next)
      this.publishTo(subscriptionId, topic, { before: current })
    }
    return { startIndex }
  }

  private chatSnapshot(chatId: string, subscriptionId: string): ChatSnapshot | null {
    const chat = this.chats.get(chatId)
    if (!chat) return null
    const project = this.projects.get(chat.projectId)!
    const start = this.windowStart(chat, subscriptionId)
    return {
      runtime: {
        chatId: chat.id,
        projectId: chat.projectId,
        localPath: project.seed.localPath,
        title: chat.title,
        status: this.chatStatus(chat),
        isDraining: false,
        provider: chat.provider,
        planMode: chat.planMode,
        autoPlan: false,
        sessionToken: chat.turnCount > 0 || chat.turn ? `demo-session-${chat.id}` : null,
        ...(chat.delegator ? { delegator: true as const } : {}),
        ...(chat.tasks.length > 0 ? { subagents: chat.tasks.map((task) => ({ ...task })) } : {}),
        ...(chat.schedules.length > 0 ? { schedules: chat.schedules.map((schedule) => ({ ...schedule })) } : {}),
      },
      queuedMessages: chat.queued,
      // Header form, as the real router sends it: tool bodies stay here
      // until a row is opened (`chat.getToolEntries`).
      messages: cloneTranscriptEntriesForClient(chat.entries.slice(start), (toolId) => (
        chat.entries.find((entry) => entry.kind === "tool_call" && entry.tool.toolId === toolId) as Extract<TranscriptEntry, { kind: "tool_call" }> | undefined
      )?.tool.toolKind),
      startIndex: start,
      availableProviders: PROVIDERS,
      readAnchor: null,
      outline: buildTranscriptOutline(chat.entries),
    }
  }
}

// ---------------------------------------------------------------------------
// Static snapshots
// ---------------------------------------------------------------------------

export function createDemoAppSettings(theme: AppThemePreference): AppSettingsSnapshot {
  return {
    analyticsEnabled: false,
    browserSettingsMigrated: true,
    theme,
    chatSoundPreference: "never",
    chatSoundId: "funk",
    chatBrowserNotificationPreference: "never",
    terminal: { scrollbackLines: 1000, minColumnWidth: 450, webglRenderer: false },
    editor: { preset: "cursor", commandTemplate: getDefaultEditorCommandTemplate("cursor") },
    transcript: { windowAssistantMessages: DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES },
    defaultProvider: "claude",
    submitWhileRunning: "queue",
    paneVisibility: { widgets: "chat", terminal: "chat" },
    providerDefaults: createDefaultProviderDefaults(),
    newSidebarEnabled: true,
    newProjectsDirectory: "~/Kanna",
    // Setup is marked done so the onboarding wizard never opens over the demo.
    setupShown: true,
    setupCompleted: true,
    setupDismissed: false,
    warning: null,
    filePathDisplay: "~/.kanna/settings.json",
    devbox: false,
    availableProviders: PROVIDERS,
    installedEditors: ["cursor", "vscode", "zed"],
    installedTerminals: null,
  }
}

function createKeybindings(): KeybindingsSnapshot {
  return { bindings: DEFAULT_KEYBINDINGS, warning: null, filePathDisplay: "~/.kanna/keybindings.json" }
}

function createUpdate(now: number): UpdateSnapshot {
  return {
    currentVersion: KANNA_VERSION,
    latestVersion: KANNA_VERSION,
    status: "up_to_date",
    updateAvailable: false,
    lastCheckedAt: now,
    error: null,
    installAction: "restart",
    reloadRequestedAt: null,
  }
}

// Every harness is signed in except Grok Build, which isn't installed, and
// GitHub's CLI isn't signed in (so the home page lists no GitHub repos).
function createProviderAuth(): ProviderAuthSnapshot {
  return {
    services: AUTH_SERVICE_ORDER.map((service) => ({
      service,
      label: AUTH_SERVICE_LABELS[service],
      installed: service !== "grok",
      version: null,
      latestVersion: null,
      updateAvailable: false,
      authStatus: service === "grok" ? "not_installed" : service === "gh" ? "signed_out" : "signed_in",
      account: null,
      statusDetail: null,
      login: { phase: "idle" },
      installState: "idle",
      installError: null,
      checkedAt: null,
    })),
  }
}

function createLlmProvider(): LlmProviderSnapshot {
  return {
    provider: "openrouter",
    apiKey: "",
    model: DEFAULT_OPENROUTER_SDK_MODEL,
    baseUrl: "",
    resolvedBaseUrl: "https://openrouter.ai/api/v1",
    faveModels: DEFAULT_PI_FAVE_MODELS,
    enabled: false,
    warning: null,
    filePathDisplay: "~/.kanna/llm-provider.json",
  }
}

function createUsageLimits(now: number): UsageLimitsSnapshot {
  const at = (hours: number) => new Date(now + hours * 60 * 60_000).toISOString()
  const recordedAt = new Date(now - 2 * 60_000).toISOString()
  return {
    providers: [
      {
        provider: "claude",
        status: "ok",
        plan: "max",
        windows: [
          { id: "five_hour", label: "5-hour session", usedPercent: 42, resetsAt: at(2.5), recordedAt, source: "cache" },
          { id: "seven_day", label: "Weekly", usedPercent: 18, resetsAt: at(80), recordedAt, source: "cache" },
          { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 27, resetsAt: at(80), recordedAt, source: "cache" },
        ],
        credits: null,
        detail: null,
        updatedAt: recordedAt,
      },
      {
        provider: "codex",
        status: "ok",
        plan: "pro",
        windows: [
          { id: "codex:primary", label: "5-hour session", usedPercent: 9, resetsAt: at(4), recordedAt, source: "cache" },
          { id: "codex:secondary", label: "Weekly", usedPercent: 31, resetsAt: at(120), recordedAt, source: "cache" },
        ],
        credits: null,
        detail: null,
        updatedAt: recordedAt,
      },
      {
        provider: "cursor",
        status: "unavailable",
        plan: null,
        windows: [],
        credits: null,
        detail: "Cursor doesn't report usage limits for API keys.",
        updatedAt: null,
      },
    ],
  }
}

function createAccounts(): ProviderAccount[] {
  const existing = (provider: AgentProvider, identity: string): ProviderAccount => ({
    id: existingAccountId(provider),
    provider,
    label: "Current",
    mode: "existing",
    identity,
    authStatus: "signed_in",
    login: { phase: "idle" },
    statusDetail: null,
  })
  return [
    existing("claude", "you@example.com"),
    existing("codex", "you@example.com"),
    {
      id: "account-cursor-work",
      provider: "cursor",
      label: "Work",
      mode: "apiKey",
      identity: null,
      authStatus: "signed_in",
      login: { phase: "idle" },
      statusDetail: null,
    },
  ]
}

function createMcpServers(): McpServerSummary[] {
  return [
    {
      id: "mcp-github",
      name: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      providers: ["claude", "codex", "cursor", "pi"],
      argumentCount: 0,
      environmentKeys: [],
      headerKeys: [],
      hasClientSecret: false,
      status: "connected",
      toolCount: 41,
    },
    {
      id: "mcp-playwright",
      name: "playwright",
      transport: "stdio",
      command: "npx",
      providers: ["claude", "codex"],
      argumentCount: 2,
      environmentKeys: [],
      headerKeys: [],
      hasClientSecret: false,
      status: "unconnected",
    },
  ]
}

function createGlobalSkills(): GlobalSkillSummary[] {
  return [
    {
      name: "frontend-design",
      description: "Build distinctive, production-grade interfaces instead of generic ones.",
      providers: ["claude", "codex", "cursor", "grok", "pi"],
      paths: [`${DEMO_HOME}/.agents/skills/frontend-design/SKILL.md`],
      source: "anthropics/skills",
    },
    {
      name: "release-notes",
      description: "Write release notes from the commits since the last tag.",
      providers: ["claude", "codex"],
      paths: [`${DEMO_HOME}/.claude/skills/release-notes/SKILL.md`],
    },
  ]
}

/** The composer's "/" menu: the harness's own commands, then the global skills it can use. */
function demoSkills(provider: AgentProvider, globalSkills: GlobalSkillSummary[]): HarnessSkill[] {
  const builtins: Record<AgentProvider, HarnessSkill[]> = {
    claude: [
      { name: "compact", description: "Clear the conversation but keep a summary in context", source: "builtin" },
      { name: "review", description: "Review a pull request", source: "builtin" },
      { name: "init", description: "Initialize a CLAUDE.md file with codebase documentation", source: "builtin" },
    ],
    codex: [
      { name: "review", description: "Review my current changes and find issues", source: "builtin" },
      { name: "init", description: "Create an AGENTS.md file with instructions for Codex", source: "builtin" },
    ],
    cursor: [],
    grok: [],
    pi: [],
  }
  const skills = globalSkills
    .filter((skill) => skill.providers.includes(provider))
    .map((skill): HarnessSkill => ({ name: skill.name, description: skill.description, source: "skill", path: skill.paths[0] }))
  return [...builtins[provider], ...skills]
}

/** What the Skills page finds on skills.sh, in the demo. */
const SKILL_CATALOG: SkillSearchResult[] = [
  { id: "anthropics/skills/pdf", skillId: "pdf", name: "pdf", installs: 48_210, source: "anthropics/skills" },
  { id: "anthropics/skills/xlsx", skillId: "xlsx", name: "xlsx", installs: 31_877, source: "anthropics/skills" },
  { id: "vercel-labs/agent-skills/react-best-practices", skillId: "react-best-practices", name: "react-best-practices", installs: 27_450, source: "vercel-labs/agent-skills" },
  { id: "obra/superpowers/test-driven-development", skillId: "test-driven-development", name: "test-driven-development", installs: 12_034, source: "obra/superpowers" },
]
