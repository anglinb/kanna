// The composer gallery's states (gallery/composer.tsx and the Foldkit page of
// the same name): ChatInput's props, and what its stores hold, per
// `?state=` on the page's URL.
import type {
  AuthServiceSnapshot,
  ChatAttachment,
  HarnessSkill,
  ProviderAuthSnapshot,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
} from "../../../../shared/types"
import type { ContextWindowSnapshot } from "../../../../client/lib/contextWindow"

export const GALLERY_CHAT_ID = "gallery-chat"
export const GALLERY_PROJECT_ID = "gallery-project-tidepool"

function row(chatId: string, title: string, extra: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title,
    status: "idle",
    unread: false,
    localPath: "/Users/maya/code/tidepool",
    provider: "claude",
    lastMessageAt: 1_780_000_000_000,
    canFork: true,
    ...extra,
  } as SidebarChatRow
}

function group(groupKey: string, title: string, localPath: string, chats: SidebarChatRow[], lastActivityAt: number): SidebarProjectGroup {
  return {
    groupKey,
    title,
    realTitle: title,
    localPath,
    repoName: title,
    branchName: "main",
    chats,
    previewChats: chats,
    olderChats: [],
    defaultCollapsed: false,
    lastActivityAt,
  } as unknown as SidebarProjectGroup
}

export const GALLERY_SIDEBAR: SidebarData = {
  projectGroups: [
    group(GALLERY_PROJECT_ID, "tidepool", "/Users/maya/code/tidepool", [], 1_780_000_000_000),
    group("gallery-project-portolan", "portolan", "/Users/maya/code/portolan", [], 1_779_000_000_000),
    group("gallery-project-almanac", "almanac", "/Users/maya/code/almanac", [], 1_778_000_000_000),
    group("gallery-project-porthole", "porthole", "/Users/maya/code/porthole", [], 1_777_000_000_000),
  ],
} as SidebarData

/** The delegate state's project: tidepool with two delegators. */
export const GALLERY_DELEGATE_SIDEBAR: SidebarData = {
  projectGroups: [
    group(GALLERY_PROJECT_ID, "tidepool", "/Users/maya/code/tidepool", [
      row("gallery-delegator-release", "Release captain", { delegator: true, lastMessageAt: 1_780_000_000_000 } as Partial<SidebarChatRow>),
      row("gallery-delegator-triage", "Bug triage", { delegator: true, provider: undefined, lastMessageAt: 1_779_000_000_000 } as Partial<SidebarChatRow>),
      row("gallery-chat-under", "Fix the tide chart", { parentChatId: "gallery-delegator-release", unread: true, status: "waiting_for_user" } as Partial<SidebarChatRow>),
    ], 1_780_000_000_000),
  ],
} as SidebarData

export const GALLERY_SKILLS: HarnessSkill[] = [
  { name: "compact", description: "Clear the conversation but keep a summary in context", source: "builtin" } as HarnessSkill,
  { name: "frontend-design", description: "Build distinctive, production-grade interfaces instead of generic ones.", source: "skill" } as HarnessSkill,
  { name: "init", description: "Initialize a CLAUDE.md file with codebase documentation", source: "builtin" } as HarnessSkill,
  { name: "release-notes", description: "Write release notes from the commits since the last tag.", argumentHint: "[since]", source: "command" } as HarnessSkill,
  { name: "review", description: "Review a pull request", argumentHint: "<pr>", source: "builtin" } as HarnessSkill,
]

// 1×1 swatches as data URLs, so an image attachment draws the same in both apps.
const SWATCH = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

export const GALLERY_ATTACHMENTS: ChatAttachment[] = [
  {
    id: "gallery-attachment-notes",
    kind: "file",
    displayName: "tide-notes.txt",
    absolutePath: "/Users/maya/code/tidepool/.kanna/uploads/tide-notes.txt",
    relativePath: ".kanna/uploads/tide-notes.txt",
    contentUrl: "/api/projects/gallery-project-tidepool/uploads/tide-notes.txt/content",
    mimeType: "text/plain",
    size: 2_048,
  },
  {
    id: "gallery-attachment-swell",
    kind: "image",
    displayName: "swell.png",
    absolutePath: "/Users/maya/code/tidepool/.kanna/uploads/swell.png",
    relativePath: ".kanna/uploads/swell.png",
    contentUrl: SWATCH,
    mimeType: "image/png",
    size: 48_213,
  },
]

export const GALLERY_CONTEXT_WINDOW: ContextWindowSnapshot = {
  usedTokens: 84_000,
  maxTokens: 200_000,
  compactsAutomatically: true,
  usedPercentage: 42,
  remainingTokens: 116_000,
  remainingPercentage: 58,
  updatedAt: "2026-06-01T11:58:00.000Z",
}

function service(id: AuthServiceSnapshot["service"], label: string, authStatus: AuthServiceSnapshot["authStatus"]): AuthServiceSnapshot {
  return {
    service: id,
    label,
    installed: true,
    version: "1.0.0",
    latestVersion: "1.0.0",
    updateAvailable: false,
    authStatus,
    account: null,
    statusDetail: null,
    login: { status: "idle" },
    installState: "idle",
  } as unknown as AuthServiceSnapshot
}

/** Codex and Cursor signed out: the harness picker says "Sign In" against them. */
export const GALLERY_SIGNED_OUT_AUTH: ProviderAuthSnapshot = {
  services: [
    service("claude", "Claude Code", "signed_in"),
    service("codex", "Codex", "signed_out"),
    service("cursor", "Cursor", "signed_out"),
  ],
}

/** Two Claude accounts: the account picker shows. */
export const GALLERY_ACCOUNTS_AUTH: ProviderAuthSnapshot = {
  services: [service("claude", "Claude Code", "signed_in")],
  accounts: [
    { id: "existing-claude", provider: "claude", label: "Personal", identity: "maya@example.com", authStatus: "signed_in" },
    { id: "work-claude", provider: "claude", label: "Work", identity: null, authStatus: "signed_in" },
  ],
  defaultAccountIds: { claude: "existing-claude" },
} as unknown as ProviderAuthSnapshot

export interface ComposerGalleryState {
  draft?: string
  attachments?: ChatAttachment[]
  canCancel?: boolean
  disabled?: boolean
  /** No project: files can't be attached, and the placeholder says so. */
  noProject?: boolean
  contextWindow?: boolean
  auth?: ProviderAuthSnapshot
  sidebar?: SidebarData
  /** The new chat page with its delegate control. */
  delegate?: boolean
  previousPrompt?: string
}

export const COMPOSER_GALLERY_STATES: Record<string, ComposerGalleryState> = {
  empty: {},
  draft: { draft: "Show the swell direction as an arrow" },
  multiline: { draft: "Show the swell direction as an arrow\nand keep the degrees in a tooltip\n\nThe forecast card is in src/components/ForecastCard.tsx" },
  attachments: { draft: "The swell chart from this morning, and my notes", attachments: GALLERY_ATTACHMENTS },
  processing: { canCancel: true },
  "processing-draft": { canCancel: true, draft: "Also add a table of contents" },
  disabled: { disabled: true },
  "no-project": { noProject: true },
  meter: { contextWindow: true },
  unauthenticated: { auth: GALLERY_SIGNED_OUT_AUTH },
  accounts: { auth: GALLERY_ACCOUNTS_AUTH },
  delegate: { delegate: true, sidebar: GALLERY_DELEGATE_SIDEBAR },
  recall: { previousPrompt: "Show the swell direction as an arrow" },
}

export function composerGalleryState(search: string): ComposerGalleryState {
  const name = new URLSearchParams(search).get("state") ?? "empty"
  return COMPOSER_GALLERY_STATES[name] ?? {}
}
