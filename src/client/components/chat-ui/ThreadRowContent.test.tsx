import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../shared/types"
import { renderChatStatusDot } from "./ThreadRowContent"

const baseChat: SidebarChatRow = {
  _id: "chat-1",
  _creationTime: 1,
  chatId: "chat-1",
  title: "Test chat",
  status: "idle",
  unread: false,
  localPath: "/tmp/project",
  provider: "claude",
  lastMessageAt: 0,
  hasAutomation: false,
}

function render(chat: SidebarChatRow) {
  const dot = renderChatStatusDot(chat)
  return dot === null ? null : renderToStaticMarkup(<>{dot}</>)
}

describe("renderChatStatusDot", () => {
  test("renders nothing for an idle chat with no uncommitted work", () => {
    expect(render(baseChat)).toBeNull()
  })

  test("renders a muted dot for uncommitted work", () => {
    const html = render({ ...baseChat, uncommittedWork: true })

    expect(html).toContain("bg-muted-foreground/40")
  })

  test("the uncommitted-work dot never pulses", () => {
    const html = render({ ...baseChat, uncommittedWork: true })

    // It's an ambient hint, not a call to action — a pulse would compete with
    // the unread/awaiting dots for attention.
    expect(html).not.toContain("animate-ping")
    expect(html).not.toContain("animate-spin")
  })

  test("unread outranks uncommitted work", () => {
    const html = render({ ...baseChat, unread: true, uncommittedWork: true })

    expect(html).toContain("bg-emerald-400")
    expect(html).toContain("animate-ping")
    expect(html).not.toContain("bg-muted-foreground/40")
  })

  test("awaiting the user outranks uncommitted work", () => {
    const html = render({ ...baseChat, status: "waiting_for_user", uncommittedWork: true })

    expect(html).toContain("bg-blue-400")
    expect(html).not.toContain("bg-muted-foreground/40")
  })

  test("a running turn outranks uncommitted work", () => {
    const html = render({ ...baseChat, status: "running", uncommittedWork: true })

    expect(html).toContain("animate-spin")
    expect(html).not.toContain("bg-muted-foreground/40")
  })

  test("the muted dot matches the others' footprint so rows stay aligned", () => {
    const muted = render({ ...baseChat, uncommittedWork: true })
    const unread = render({ ...baseChat, unread: true })

    for (const html of [muted, unread]) {
      expect(html).toContain("size-4")
      expect(html).toContain("size-2.5")
      expect(html).toContain("rounded-full")
    }
  })
})
