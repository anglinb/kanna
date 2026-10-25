import { existingAccountId } from "../../shared/accounts"
import { shouldSteerSubmit } from "../../shared/submit-mode"
import {
  PROVIDERS,
  resolveClaudeContextWindowMaxTokens,
  withPiFaveModels,
  type AgentProvider,
  type ChatAttachment,
  type HarnessSkill,
  type ModelOptions,
  type ProviderCatalogEntry,
} from "../../shared/types"
import { getProjectIdForChat } from "../../client/app/kannaStateHelpers"
import { delegatorDisplayTitle, projectDelegators, resolveDelegateTarget } from "../../client/lib/delegators"
import { deriveLatestContextWindowSnapshot, overrideContextWindowMaxTokens, type ContextWindowSnapshot } from "../../client/lib/contextWindow"
import { abbreviatePathHead, formatPathWithTilde } from "../../client/lib/pathUtils"
import { getProjectSidebarLabel } from "../../client/lib/project-label"
import {
  CODEX_SKILL_MENU_TRIGGERS,
  DEFAULT_SKILL_MENU_TRIGGERS,
  filterSkillMenuItems,
  getActiveSkillMention,
  type ActiveSkillMention,
} from "../../client/lib/skill-menu"
import {
  filterProjectMentionItems,
  getActiveProjectMention,
  projectMentionCandidates,
  type ActiveProjectMention,
  type ProjectMentionItem,
} from "../../client/lib/project-mention"
import { flattenSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import { routeChatId } from "../app/route"
import type { Model as AppModel } from "../app/model"
import type * as Stores from "../app/stores"
import * as ChatSession from "../core/chatSession"
import * as AppSettings from "../core/stores/appSettings"
import * as ChatInput from "../core/stores/chatInput"
import * as ChatPreferences from "../core/stores/chatPreferences"
import type { ComposerState } from "../core/stores/chatPreferences"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as Sidebar from "../core/stores/sidebar"
import { deriveComposerOptionControls, deriveComposerView, type ComposerOptionControls, type ComposerView } from "./controls"
import type { ComposerAttachment, Model } from "./model"

// What ChatInput was handed (its props) and read from the stores, and what
// it worked out from both on each render.

/** The new chat page's delegate control (`DelegateControl`'s props, as data): chat/newChatDelegate's `NewChatDelegate`. */
export interface ComposerDelegate {
  /** The project's delegators, most recently active first. Never empty. */
  delegators: ReadonlyArray<SidebarThread>
  /** The one the message goes to, or null while not delegating. */
  target: SidebarThread | null
  projectName: string
}

/** ChatInput's props, less the callbacks: those are Messages and AppActions here. */
export interface ComposerProps {
  chatId: string | null
  /** Where the draft is kept, when it is not the chat's own (a second composer). */
  draftKey?: string | null
  projectId: string | null
  projectPath: string | null
  projectRepoLabel: string | null
  disabled: boolean
  canCancel: boolean
  activeProvider: AgentProvider | null
  accountIds?: Partial<Record<AgentProvider, string>>
  availableProviders: ReadonlyArray<ProviderCatalogEntry>
  contextWindowSnapshot: ContextWindowSnapshot | null
  previousPrompt: string | null
  /** `onListSkills` was given: the "/" menu lists the harness's skills (`chat.listSkills`). */
  listSkills: boolean
  /** `onEditModels` was given: the pi model picker offers "Add models…". */
  editModels: boolean
  placeholder?: string
  secondary: boolean
  delegate: ComposerDelegate | null
}

export interface Context {
  props: ComposerProps
  stores: Stores.Model
}

/** What the chat page hands its composer on top of the root Model (ChatInputDock's props; `page.composer` and `page.delegate`). */
export interface PageComposerInputs {
  hasSelectedProject: boolean
  canCancel: boolean
  projectPath: string | null
  projectRepoLabel: string | null
  contextWindowSnapshot: ContextWindowSnapshot | null
  delegate: ComposerDelegate | null
}

// The chat page's selectors (chat/page.ts), restated: a value import of
// chat/ from here would be a cycle (chat/ imports this slice).

function activeSnapshot(app: AppModel) {
  const chatId = routeChatId(app.route)
  return app.chat && app.chat.chatId === chatId ? ChatSession.snapshotOf(app.chat) : null
}

function activeProjectId(app: AppModel): string | null {
  const chatId = routeChatId(app.route)
  return activeSnapshot(app)?.runtime.projectId
    ?? (chatId ? getProjectIdForChat(app.stores.sidebar.data.projectGroups, chatId) : null)
    ?? app.selectedProjectId
}

function navbarLocalPath(app: AppModel): string | null {
  const chatId = routeChatId(app.route)
  const projectId = activeProjectId(app)
  const sidebar = app.stores.sidebar.data
  const fromSidebar = chatId && projectId
    ? sidebar.projectGroups.find((group) => group.groupKey === projectId)?.localPath ?? null
    : null
  return activeSnapshot(app)?.runtime.localPath
    ?? fromSidebar
    ?? app.localProjects?.projects[0]?.localPath
    ?? sidebar.projectGroups[0]?.localPath
    ?? null
}

/**
 * useNewChatDelegate's control, as chat/newChatDelegate works it out. The
 * page holds the empty state over while an unknown chat loads; that hold is
 * the page's own state, so here such a chat has no control (the view has
 * the page's, exact).
 */
function delegateFromApp(app: AppModel): ComposerDelegate | null {
  const chatId = routeChatId(app.route)
  const snapshot = activeSnapshot(app)
  const chat = app.chat && app.chat.chatId === chatId ? app.chat : null
  const messageCount = chat?.messages.length ?? 0
  const sidebar = app.stores.sidebar
  const isChatLoading = Boolean(chatId && !snapshot)
  const started = Boolean(chatId && app.actions.startedChat?.chatId === chatId && !snapshot)
  const isKnownNewChat = Sidebar.sidebarChatIsNew(sidebar, chatId) || started
  const showEmptyState = isChatLoading
    ? isKnownNewChat && messageCount === 0
    : messageCount === 0 && snapshot?.runtime.title === "New Chat"
  const enabled = showEmptyState && (!isChatLoading || isKnownNewChat) && !Sidebar.chatIsDelegator(sidebar, chatId)
  const projectId = activeProjectId(app)
  if (!enabled || !projectId) return null
  const group = sidebar.data.projectGroups.find((item) => item.groupKey === projectId) ?? null
  if (!group) return null
  const delegators = projectDelegators(flattenSidebarThreads({ projectGroups: [group] }), group.groupKey)
  if (delegators.length === 0) return null
  return {
    delegators,
    target: resolveDelegateTarget(delegators, app.stores.delegate.projects[projectId]),
    projectName: getProjectSidebarLabel(group).name,
  }
}

/** The page's inputs for its composer, from the root Model alone (what `update` has). */
export function pageInputsFromApp(app: AppModel): PageComposerInputs {
  const chatId = routeChatId(app.route)
  const snapshot = activeSnapshot(app)
  const sidebar = app.stores.sidebar
  const chat = app.chat && app.chat.chatId === chatId ? app.chat : null
  const projectId = activeProjectId(app)
  const projectPath = navbarLocalPath(app)
  return {
    hasSelectedProject: Boolean(app.selectedProjectId ?? snapshot?.runtime.projectId ?? Sidebar.firstProjectGroup(sidebar).groupKey ?? app.localProjects?.projects[0]?.localPath),
    canCancel: chat ? ChatSession.canCancel(chat, Sidebar.sidebarChatStatus(sidebar, chat.chatId)) : false,
    projectPath,
    projectRepoLabel: Sidebar.navbarRepoLabel(sidebar, projectId, projectPath ?? undefined),
    contextWindowSnapshot: deriveLatestContextWindowSnapshot(snapshot?.messages ?? []),
    delegate: delegateFromApp(app),
  }
}

/**
 * The chat page's props for its main composer: what ChatPage passed
 * ChatInputDock. `page` is the chat page's own (its view inputs); without
 * it, the same worked out from the root Model.
 */
export function propsFromApp(app: AppModel, page: PageComposerInputs = pageInputsFromApp(app)): ComposerProps {
  const chatId = routeChatId(app.route)
  const chat = app.chat && app.chat.chatId === chatId ? app.chat : null
  const snapshot = activeSnapshot(app)
  const appSettings = AppSettings.appSettings(app.stores.appSettings)
  const fallbackProviders = withPiFaveModels(appSettings?.availableProviders ?? PROVIDERS, app.llmProvider?.faveModels ?? [])
  return {
    chatId,
    projectId: activeProjectId(app),
    projectPath: page.projectPath,
    projectRepoLabel: page.projectRepoLabel,
    disabled: !page.hasSelectedProject,
    canCancel: page.canCancel,
    activeProvider: snapshot?.runtime.provider ?? null,
    accountIds: snapshot?.runtime.accountIds,
    availableProviders: chat ? ChatSession.availableProviders(chat, fallbackProviders) : fallbackProviders,
    contextWindowSnapshot: page.contextWindowSnapshot,
    previousPrompt: chat ? ChatSession.previousPrompt(chat) : null,
    listSkills: true,
    editModels: true,
    secondary: false,
    delegate: page.delegate,
  }
}

export function contextFromApp(app: AppModel, page?: PageComposerInputs): Context {
  return { props: propsFromApp(app, page), stores: app.stores }
}

// DERIVED

/** The draft's key: the chat's, unless the composer keeps its own. */
export function draftIdOf(props: ComposerProps): string | null {
  return props.draftKey ?? props.chatId ?? null
}

/** React's `key`. */
export function chatKeyOf(props: ComposerProps): string {
  return props.chatId ?? "new-chat"
}

/** The delegator the message goes to, when it has settings of its own. */
export function delegateSettingsOf(props: ComposerProps) {
  const target = props.delegate?.target ?? null
  return target?.row.provider ? { chatId: target.chatId, title: target.title, provider: target.row.provider } : null
}

export type ComposerViewState = ComposerView & { optionControls: ComposerOptionControls }

/** useComposer, as data: the view of the chat's composer state. */
export function composerViewOf(ctx: Context): ComposerViewState {
  const { props, stores } = ctx
  const delegateSettings = delegateSettingsOf(props)
  const chatId = delegateSettings?.chatId ?? props.chatId ?? null
  const activeProvider = delegateSettings ? delegateSettings.provider : props.activeProvider
  const composerChatId = chatId ?? ChatPreferences.NEW_CHAT_COMPOSER_ID
  const sidebar = Sidebar.sidebarData(stores.sidebar)
  const seed = chatId ? ChatPreferences.seedForChat(sidebar, chatId) : null
  const composerState = ChatPreferences.getComposerState(stores.chatPreferences, sidebar, composerChatId, seed)
  const view = deriveComposerView({
    chatId,
    activeProvider,
    availableProviders: [...props.availableProviders],
    composerState,
    providerDefaults: stores.chatPreferences.providerDefaults,
    providerSwitchRequested: ChatPreferences.hasPendingProviderSwitch(stores.chatPreferences, composerChatId),
    chatModel: seed && seed.provider === activeProvider ? seed.model : undefined,
  })
  return { ...view, optionControls: deriveComposerOptionControls(view.effectiveState, view.providerConfig) }
}

export function placeholderOf(props: ComposerProps): string {
  // The label goes into a textarea placeholder, which browsers do not clip
  // or ellipsize the way a span would: a long path runs past the pill. Keep
  // the path short enough to fit the narrowest composer (a phone) instead.
  const projectLabel = props.projectRepoLabel ?? (props.projectPath ? abbreviatePathHead(formatPathWithTilde(props.projectPath), 40) : null)
  const delegateTarget = props.delegate?.target ?? null
  return props.placeholder
    // Who the message goes to, when that is not a new chat in the project.
    ?? (delegateTarget ? `Message ${delegatorDisplayTitle(delegateTarget.title)}` : projectLabel ? `Build in ${projectLabel}` : "Build something...")
}

export function activeContextWindow(ctx: Context, state: ComposerState): ContextWindowSnapshot | null {
  const snapshot = ctx.props.contextWindowSnapshot
  if (state.provider !== "claude") return snapshot
  const stagedMaxTokens = resolveClaudeContextWindowMaxTokens(state.model, state.modelOptions.contextWindow)
  return overrideContextWindowMaxTokens(snapshot, stagedMaxTokens)
}

export function skillMentionOf(model: Model, ctx: Context, selectedProvider: AgentProvider): ActiveSkillMention | null {
  const triggers = selectedProvider === "codex" ? CODEX_SKILL_MENU_TRIGGERS : DEFAULT_SKILL_MENU_TRIGGERS
  return ctx.props.listSkills && !ctx.props.disabled ? getActiveSkillMention(model.value, model.caret, triggers) : null
}

export function skillMenuItemsOf(model: Model, mention: ActiveSkillMention | null): HarnessSkill[] {
  return mention && model.skills ? filterSkillMenuItems([...model.skills], mention.query) : []
}

export function projectMentionOf(model: Model, ctx: Context): ActiveProjectMention | null {
  return !ctx.props.disabled ? getActiveProjectMention(model.value, model.caret) : null
}

export function projectMenuItemsOf(mention: ActiveProjectMention | null, ctx: Context): ProjectMentionItem[] {
  if (!mention) return []
  const candidates = projectMentionCandidates(Sidebar.sidebarData(ctx.stores.sidebar).projectGroups, ctx.props.projectPath ?? null)
  return filterProjectMentionItems(candidates, mention.query)
}

/** The highlighted row, counted from the top: the list renders worst match first. */
export function selectedIndex(itemCount: number, offset: number): number {
  return itemCount > 0 ? itemCount - 1 - Math.min(offset, itemCount - 1) : -1
}

export interface Menus {
  skillMention: ActiveSkillMention | null
  skillItems: HarnessSkill[]
  skillMenuOpen: boolean
  selectedSkillIndex: number
  projectMention: ActiveProjectMention | null
  projectItems: ProjectMentionItem[]
  projectMenuOpen: boolean
  selectedProjectIndex: number
}

export function menusOf(model: Model, ctx: Context, selectedProvider: AgentProvider): Menus {
  const skillMention = skillMentionOf(model, ctx, selectedProvider)
  const skillItems = skillMenuItemsOf(model, skillMention)
  const projectMention = projectMentionOf(model, ctx)
  const projectItems = projectMenuItemsOf(projectMention, ctx)
  return {
    skillMention,
    skillItems,
    skillMenuOpen: skillMention !== null && !model.skillMenuDismissed && skillItems.length > 0,
    selectedSkillIndex: selectedIndex(skillItems.length, model.skillMenuOffset),
    projectMention,
    projectItems,
    projectMenuOpen: projectMention !== null && !model.projectMenuDismissed && projectItems.length > 0,
    selectedProjectIndex: selectedIndex(projectItems.length, model.projectMenuOffset),
  }
}

export function uploadedAttachments(model: Model): ComposerAttachment[] {
  return model.attachments.filter((attachment) => attachment.status === "uploaded")
}

export function hasPendingUploads(model: Model): boolean {
  return model.attachments.some((attachment) => attachment.status === "uploading")
}

export function canSubmit(model: Model): boolean {
  return model.value.trim().length > 0 || uploadedAttachments(model).length > 0
}

/** The attachment as a send carries it, without the composer's own fields. */
export function toChatAttachment({ previewUrl: _previewUrl, status: _status, ...attachment }: ComposerAttachment): ChatAttachment {
  return attachment
}

export function hydrateComposerAttachments(attachments: ReadonlyArray<ChatAttachment>): ComposerAttachment[] {
  return attachments.map((attachment) => ({ ...attachment, status: "uploaded" as const }))
}

export interface Accounts {
  providerAccounts: NonNullable<NonNullable<ProviderAuth.Model["snapshot"]>["accounts"]>
  pinnedAccountId: string | undefined
  selectedAccountId: string | undefined
}

export function accountsOf(model: Model, ctx: Context, selectedProvider: AgentProvider): Accounts {
  const snapshot = ctx.stores.providerAuth.snapshot
  const providerAccounts = snapshot?.accounts?.filter((entry) => entry.provider === selectedProvider) ?? []
  const { props } = ctx
  const pinnedAccountId = props.accountIds?.[selectedProvider]
    ?? (props.activeProvider === selectedProvider && props.previousPrompt ? existingAccountId(selectedProvider) : undefined)
  const selectedAccountId = pinnedAccountId ?? model.accountChoices[selectedProvider] ?? snapshot?.defaultAccountIds?.[selectedProvider]
  return { providerAccounts, pinnedAccountId, selectedAccountId }
}

export function submitWhileRunningOf(ctx: Context) {
  return AppSettings.appSettings(ctx.stores.appSettings)?.submitWhileRunning ?? "queue"
}

/** The composer's current prefs, the way a send carries them (buildSubmitOptions). */
export function buildSubmitOptions(model: Model, ctx: Context, attachments: ChatAttachment[], withModifier: boolean): ChatSession.SendOptions {
  const view = composerViewOf(ctx)
  const prefs = view.effectiveState
  let modelOptions: ModelOptions
  if (prefs.provider === "claude") {
    modelOptions = { claude: { ...prefs.modelOptions } }
  } else if (prefs.provider === "cursor") {
    modelOptions = { cursor: { ...prefs.modelOptions } }
  } else if (prefs.provider === "grok") {
    modelOptions = { grok: { ...prefs.modelOptions } }
  } else if (prefs.provider === "pi") {
    modelOptions = { pi: { ...prefs.modelOptions } }
  } else {
    modelOptions = { codex: { ...prefs.modelOptions } }
  }
  const { selectedAccountId } = accountsOf(model, ctx, view.selectedProvider)
  return {
    steer: shouldSteerSubmit(submitWhileRunningOf(ctx), withModifier),
    provider: view.selectedProvider,
    accountId: delegateSettingsOf(ctx.props) ? undefined : selectedAccountId,
    model: prefs.model,
    modelOptions,
    planMode: view.supportsPlanMode ? prefs.planMode : false,
    autoPlan: view.supportsPlanMode ? prefs.autoPlan : false,
    attachments,
  }
}

export function storedDraft(ctx: Context, draftId: string | null): string | undefined {
  return draftId ? ctx.stores.chatInput.drafts[draftId] : undefined
}

export function storedAttachmentDrafts(ctx: Context, draftId: string | null) {
  return draftId ? ChatInput.getAttachmentDrafts(ctx.stores.chatInput, draftId) : []
}
