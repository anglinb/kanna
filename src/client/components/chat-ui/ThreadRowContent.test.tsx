import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../shared/types"
import type { SidebarThread } from "../../lib/thread-sections"
import { renderChatStatusDot, ThreadRowContent } from "./ThreadRowContent"

const baseChat: SidebarChatRow = {
  _id: "chat-1",
  _creationTime: 1,
  chatId: "chat-1",
  title: "Refactor the ws router",
  status: "idle",
  unread: false,
  localPath: "/tmp/project",
  provider: "claude",
  lastMessageAt: 0,
  hasAutomation: false,
}

function thread(overrides: Partial<SidebarChatRow> = {}, archived = false): SidebarThread {
  const row = { ...baseChat, ...overrides }
  return {
    chatId: row.chatId,
    title: row.title,
    projectId: "project-1",
    projectTitle: "Project",
    projectLabel: "Project/feature",
    archived,
    lastActivityAt: 1,
    row,
  }
}

function renderDot(chat: SidebarChatRow) {
  const dot = renderChatStatusDot(chat)
  return dot === null ? null : renderToStaticMarkup(<>{dot}</>)
}

function renderRow(props: Parameters<typeof ThreadRowContent>[0]) {
  return renderToStaticMarkup(<ThreadRowContent {...props} />)
}

const DIM_CLASS = "text-slate-500 dark:text-slate-400"

describe("renderChatStatusDot", () => {
  test("renders nothing for an idle chat", () => {
    expect(renderDot(baseChat)).toBeNull()
  })

  test("uncommitted work does not claim the status slot", () => {
    // It's carried by tinting the harness icon instead, so this slot only ever
    // holds things that want attention.
    expect(renderDot({ ...baseChat, uncommittedWork: true })).toBeNull()
  })

  test("unread renders a pinging green dot", () => {
    const html = renderDot({ ...baseChat, unread: true })

    expect(html).toContain("bg-emerald-400")
    expect(html).toContain("animate-ping")
  })

  test("awaiting the user outranks unread", () => {
    const html = renderDot({ ...baseChat, status: "waiting_for_user", unread: true })

    expect(html).toContain("bg-blue-400")
    expect(html).not.toContain("bg-emerald-400")
  })

  test("a running turn outranks both", () => {
    const html = renderDot({ ...baseChat, status: "running", unread: true })

    expect(html).toContain("animate-spin")
    expect(html).not.toContain("bg-emerald-400")
  })
})

describe("ThreadRowContent relevance treatment", () => {
  test("tints the harness icon and keeps the title bright for uncommitted work", () => {
    const html = renderRow({ thread: thread({ uncommittedWork: true }), showStatus: true, detailLabel: null })

    expect(html).toContain("text-logo")
    expect(html).not.toContain(DIM_CLASS)
  })

  test("dims an idle chat with nothing to say", () => {
    const html = renderRow({ thread: thread(), showStatus: true, detailLabel: null })

    expect(html).toContain(DIM_CLASS)
    expect(html).not.toContain("text-logo")
  })

  test("never dims the chat you have open", () => {
    const html = renderRow({ thread: thread(), showStatus: true, isActive: true })

    expect(html).not.toContain(DIM_CLASS)
  })

  test("never dims a chat that wants attention", () => {
    for (const overrides of [
      { unread: true },
      { status: "waiting_for_user" as const },
      { status: "failed" as const },
    ]) {
      expect(renderRow({ thread: thread(overrides), showStatus: true, detailLabel: null })).not.toContain(DIM_CLASS)
    }
  })

  test("archived chats are never tinted, however dirty the tree", () => {
    const html = renderRow({ thread: thread({ uncommittedWork: true }, true), showStatus: true, detailLabel: null })

    expect(html).not.toContain("text-logo")
    expect(html).toContain("text-muted-foreground/50")
  })

  test("dimIdleTitles=false keeps every title at full contrast", () => {
    // The command palette: you opened it to pick something, so no row is
    // background. Applies to the rows that would otherwise dim — idle and read.
    const html = renderRow({ thread: thread(), showStatus: true, detailLabel: null, dimIdleTitles: false })

    expect(html).not.toContain(DIM_CLASS)
  })

  test("dimIdleTitles=false still tints the icon for uncommitted work", () => {
    // Opting out of dimming is about attention weighting, not about hiding
    // which chats have work sitting in a dirty tree.
    const html = renderRow({
      thread: thread({ uncommittedWork: true }),
      showStatus: true,
      detailLabel: null,
      dimIdleTitles: false,
    })

    expect(html).toContain("text-logo")
  })

  test("falls back to a tinted chat bubble when the provider is unknown", () => {
    const html = renderRow({ thread: thread({ provider: null, uncommittedWork: true }), showStatus: true, detailLabel: null })

    expect(html).toContain("text-logo")
  })
})

describe("ThreadRowContent detail label", () => {
  test("renders exactly what it is given", () => {
    expect(renderRow({ thread: thread(), detailLabel: "4h" })).toContain("4h")
  })

  test("has no implicit project fallback", () => {
    // The old prop defaulted to the project title when omitted, which is how
    // the palette and the sidebar drifted apart. Nothing renders unasked now.
    const html = renderRow({ thread: thread(), detailLabel: null })

    expect(html).not.toContain("Project")
    expect(html).not.toContain("feature")
  })

  test("accepts a node so callers can render chrome there", () => {
    // The sidebar's number-jump keycap needs more than a string.
    const html = renderRow({ thread: thread(), detailLabel: <kbd data-testid="keycap">3</kbd> })

    expect(html).toContain("<kbd")
    expect(html).toContain("3")
  })
})
