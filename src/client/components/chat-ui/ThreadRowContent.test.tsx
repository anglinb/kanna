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
    const html = renderRow({ thread: thread({ uncommittedWork: true }), showStatus: true })

    expect(html).toContain("text-logo")
    expect(html).not.toContain(DIM_CLASS)
  })

  test("dims an idle chat with nothing to say", () => {
    const html = renderRow({ thread: thread(), showStatus: true })

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
      expect(renderRow({ thread: thread(overrides), showStatus: true })).not.toContain(DIM_CLASS)
    }
  })

  test("archived chats are never tinted, however dirty the tree", () => {
    const html = renderRow({ thread: thread({ uncommittedWork: true }, true), showStatus: true })

    expect(html).not.toContain("text-logo")
    expect(html).toContain("text-muted-foreground/50")
  })

  test("falls back to a tinted chat bubble when the provider is unknown", () => {
    const html = renderRow({ thread: thread({ provider: null, uncommittedWork: true }), showStatus: true })

    expect(html).toContain("text-logo")
  })
})

describe("ThreadRowContent trailing label", () => {
  test("shows the project title by default", () => {
    expect(renderRow({ thread: thread() })).toContain("Project")
  })

  test("a string label replaces the project title", () => {
    const html = renderRow({ thread: thread(), trailingLabel: "4h" })

    expect(html).toContain("4h")
    expect(html).not.toContain("Project")
  })

  test("null hides the trailing label entirely", () => {
    expect(renderRow({ thread: thread(), trailingLabel: null })).not.toContain("Project")
  })

  test("accepts a node so callers can render chrome there", () => {
    // The sidebar's number-jump keycap needs more than a string.
    const html = renderRow({ thread: thread(), trailingLabel: <kbd data-testid="keycap">3</kbd> })

    expect(html).toContain("<kbd")
    expect(html).toContain("3")
  })
})
