import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../../shared/types"
import type { SidebarThread } from "../../../lib/thread-sections"
import { ChatHoverCardContent } from "./ChatHoverCard"

const NOW = Date.now()

function thread(
  overrides: Partial<SidebarChatRow> = {},
  label?: SidebarThread["projectLabel"],
): SidebarThread {
  const row: SidebarChatRow = {
    _id: "chat-1",
    _creationTime: NOW - 60 * 60 * 1000,
    chatId: "chat-1",
    title: "Refactor the ws router",
    status: "idle",
    unread: false,
    localPath: "/repo",
    provider: "claude",
    hasAutomation: false,
    // An answered turn: the prompt, then the reply to it a minute later.
    lastMessageAt: NOW - 2 * 60_000,
    lastUserMessagePreview: "make the sidebar labels shorter",
    lastAgentMessagePreview: "Done — the branch moved into the hover card.",
    lastAgentMessagePreviewAt: NOW - 60_000,
    ...overrides,
  }
  return {
    chatId: row.chatId,
    title: row.title,
    projectId: "project-1",
    projectTitle: "kanna",
    projectLabel: label ?? {
      name: "kanna",
      branchName: "feat/hover-card",
      currentBranch: "feat/hover-card",
      repoPath: "jakemor/kanna",
      hasOwner: true,
      text: "kanna/feat/hover-card",
    },
    archived: false,
    lastActivityAt: NOW,
    row,
  }
}

function render(overrides: Partial<SidebarChatRow> = {}, label?: SidebarThread["projectLabel"]) {
  return renderToStaticMarkup(<ChatHoverCardContent thread={thread(overrides, label)} />)
}

describe("ChatHoverCardContent", () => {
  test("carries what the row could not: the project, the prompt, the reply", () => {
    const html = render()

    expect(html).toContain("jakemor/kanna")
    expect(html).toContain("make the sidebar labels shorter")
    expect(html).toContain("Done — the branch moved into the hover card.")
    // The project heads the card; the exchange follows it.
    expect(html.indexOf("jakemor/kanna")).toBeLessThan(html.indexOf("make the sidebar"))
  })

  test("names the branch on the project line, `main` included", () => {
    // The row can only afford the glyph, so it shows one just for a surprising
    // branch; the card has the room to always say which branch you're on.
    const onMain = render({}, {
      name: "kanna",
      currentBranch: "main",
      repoPath: "jakemor/kanna",
      hasOwner: true,
      text: "kanna",
    })

    expect(onMain).toContain("main")
    expect(onMain).toContain("lucide-git-branch")
  })

  test("a detached HEAD has no branch to name", () => {
    const detached = render({}, {
      name: "kanna",
      repoPath: "jakemor/kanna",
      hasOwner: true,
      text: "kanna",
    })

    expect(detached).not.toContain("lucide-git-branch")
  })

  test("drops a reply the current prompt hasn't earned", () => {
    // Sent again and still waiting: pairing the new question with the old
    // answer would read as though it had already come back.
    const html = render({ status: "running", lastMessageAt: NOW - 10_000 })

    expect(html).toContain("make the sidebar labels shorter")
    expect(html).not.toContain("Done — the branch moved into the hover card.")
  })

  test("an undated reply falls back to the agent's last activity", () => {
    // Chats whose last text predates the preview timestamp still pair up.
    const html = render({
      lastAgentMessagePreviewAt: undefined,
      lastAgentMessageAt: NOW - 60_000,
    })

    expect(html).toContain("Done — the branch moved into the hover card.")
  })

  test("times a live turn from its start, not from the last message", () => {
    const html = render({
      status: "running",
      lastTurnStartedAt: NOW - 65_000,
      lastMessageAt: NOW - 5_000,
    })

    expect(html).toContain("1m 5s")
  })

  test("a finished turn reports how long it ran, in the transcript's format", () => {
    const html = render({
      lastTurnStartedAt: NOW - 5 * 60_000,
      lastTurnEndedAt: NOW - 3 * 60_000,
    })

    expect(html).toContain("2m")
  })

  test("anchors duration and landing time together at the right edge", () => {
    const endedAt = NOW - 60_000
    const time = new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const html = render({ lastTurnStartedAt: NOW - 2 * 60_000, lastTurnEndedAt: endedAt })

    const anchored = html.slice(html.indexOf("ml-auto"))
    expect(anchored).toContain("1m")
    expect(anchored).toContain(time)
    expect(anchored.indexOf("1m")).toBeLessThan(anchored.indexOf(time))
  })

  test("a live turn shows no end time — the only one on hand is the previous turn's", () => {
    const endedAt = NOW - 30 * 60_000
    const time = new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const html = render({
      status: "running",
      lastTurnEndedAt: endedAt,
      lastTurnStartedAt: NOW - 60_000,
    })

    expect(html).toContain("1m")
    expect(html).not.toContain(time)
  })

  test("names the harness with its glyph, and nothing between them", () => {
    const html = render({ provider: "codex", lastTurnStartedAt: NOW - 60_000, lastTurnEndedAt: NOW })

    expect(html).toContain("viewBox=\"0 0 158.7128 157.296\"")
    expect(html).toContain("Codex")
    // The turn's numbers are right-anchored (the footer's `ml-auto`, the last
    // one in the card), so the glyph and name sit alone on the left with no
    // separator of any kind between them.
    expect(html.indexOf("Codex")).toBeLessThan(html.lastIndexOf("ml-auto"))
  })

  test("a project with nothing to qualify it shows no separators at all", () => {
    const html = render(
      { provider: null, lastTurnStartedAt: undefined, lastTurnEndedAt: undefined },
      { name: "kanna", currentBranch: "main", repoPath: "jakemor/kanna", hasOwner: true, text: "kanna" },
    )

    expect(html).not.toContain("•")
  })

  test("a chat that has never run a turn simply has no duration", () => {
    // Old chats predate turn-start recording; they lose the chip rather than
    // showing a duration measured from something that isn't the turn.
    const html = render({ lastTurnEndedAt: NOW - 1000 })

    // No start time means no duration; the landing time still stands alone.
    expect(html).not.toContain("ml-auto shrink-0 pl-2\"><span>")
  })

  test("falls back to the chat title when there is no prompt yet", () => {
    const html = render({ lastUserMessagePreview: undefined, lastAgentMessagePreview: undefined })

    expect(html).toContain("Refactor the ws router")
  })
})
