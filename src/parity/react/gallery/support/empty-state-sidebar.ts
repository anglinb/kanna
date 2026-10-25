import type { SidebarChatRow, SidebarData } from "../../../../shared/types"

// Shared by the React and Foldkit empty-state galleries: one project's chats
// in every state the new chat page's list draws (running, waiting on you,
// unread, a delegator, pinned, across the date headings), against the
// parity clock (2026-06-01T12:00Z).

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function row(chatId: string, title: string, minutesAgo: number, extra: Partial<SidebarChatRow> = {}): SidebarChatRow {
  const at = NOW - minutesAgo * MINUTE
  return {
    _id: chatId,
    _creationTime: at,
    chatId,
    title,
    status: "idle",
    unread: false,
    localPath: "/Users/demo/code/tidepool",
    provider: "claude",
    lastMessageAt: at,
    lastTurnStartedAt: at,
    lastTurnEndedAt: at,
    turnCount: 3,
    canFork: true,
    ...extra,
  } as SidebarChatRow
}

export const EMPTY_STATE_PROJECT_ID = "gallery-project-tidepool"
export const EMPTY_STATE_PROJECT_PATH = "/Users/demo/code/tidepool"

export const EMPTY_STATE_SIDEBAR: SidebarData = {
  projectGroups: [{
    groupKey: EMPTY_STATE_PROJECT_ID,
    title: "tidepool",
    realTitle: "tidepool",
    localPath: EMPTY_STATE_PROJECT_PATH,
    repoName: "tidepool",
    branchName: "main",
    hasGitRepo: true,
    chats: [
      row("g-running", "Add a feet/meters toggle", 2, { status: "running", lastUserMessagePreview: "Add a toggle so people can switch to meters" }),
      row("g-waiting", "Pick a chart library", 9, { status: "waiting_for_user", lastUserMessagePreview: "Which one is lighter?" }),
      row("g-unread", "Fix blank tide chart in Safari", 48, { unread: true, lastUserMessagePreview: "The chart is blank on Safari 17" }),
      row("g-delegator", "Release manager", 30, { delegator: true, provider: "codex", lastUserMessagePreview: "Cut the 1.4 release" }),
      row("g-pinned", "Design notes", 3 * 60, { pinnedAt: NOW - 2 * DAY, lastUserMessagePreview: "Collect the open questions" }),
      row("g-today", "Set up deploys on push", 5 * 60, { lastUserMessagePreview: "Deploy main to Pages" }),
      row("g-yesterday", "Rate limit the tide API", 26 * 60, { provider: "cursor", lastUserMessagePreview: "429s from NOAA" }),
      row("g-week", "Write the README", 4 * 24 * 60, { provider: "codex" }),
      row("g-older", "Port the charts to SVG", 20 * 24 * 60),
    ],
    archivedChats: [
      row("g-archived", "Try the canvas renderer", 40 * 24 * 60),
    ],
  }],
} as unknown as SidebarData
