import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../../shared/types"
import type { SidebarThread } from "../../../lib/thread-sections"
import { TooltipProvider } from "../../ui/tooltip"
import { ThreadRow } from "./ThreadRow"

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
  canFork: true,
}

function thread(overrides: Partial<SidebarChatRow> = {}, archived = false): SidebarThread {
  const row = { ...baseChat, ...overrides }
  return {
    chatId: row.chatId,
    title: row.title,
    projectId: "project-1",
    projectTitle: "Project",
    projectLabel: { name: "Project", branchName: "feature", repoPath: "acme/Project", text: "Project/feature" },
    archived,
    lastActivityAt: 1,
    row,
  }
}

function render(props: Partial<Parameters<typeof ThreadRow>[0]> = {}) {
  return renderToStaticMarkup(
    // The row is a hover-card trigger, and Radix tooltips need their provider.
    <TooltipProvider>
    <ThreadRow
      thread={thread()}
      isActive={false}
      editorLabel="VS Code"
      detailLabel={null}
      onSelect={() => undefined}
      onCreateChat={() => undefined}
      onRenameChat={() => undefined}
      onShareChat={() => undefined}
      onCopyPath={() => undefined}
      onOpenExternalPath={() => undefined}
      onForkChat={() => undefined}
      onArchiveChat={() => undefined}
      onRestoreChat={() => undefined}
      onDeleteChat={() => undefined}
      {...props}
    />
    </TooltipProvider>
  )
}

describe("ThreadRow", () => {
  test("carries the scroll-to-active marker", () => {
    // The sidebar's scroll-to-active querySelector depends on this attribute.
    expect(render()).toContain('data-chat-id="chat-1"')
  })

  test("renders the detail label it is given", () => {
    const html = render({ detailLabel: "4h" })

    expect(html).toContain("4h")
    expect(html).not.toContain("Project")
  })

  test("renders a node detail label, e.g. the number-jump keycap", () => {
    const html = render({ detailLabel: <kbd>3</kbd> })

    expect(html).toContain("<kbd")
  })

  test("offers Fork and Archive on a live chat", () => {
    const html = render()

    expect(html).toContain('title="Fork chat"')
    expect(html).toContain('title="Archive chat"')
  })

  test("drops Fork when the chat cannot be forked", () => {
    const html = render({ thread: thread({ canFork: undefined }) })

    expect(html).not.toContain('title="Fork chat"')
    expect(html).toContain('title="Archive chat"')
  })

  test("archived rows offer Restore instead", () => {
    const html = render({ thread: thread({}, true), archived: true })

    expect(html).toContain('title="Restore chat"')
    expect(html).not.toContain('title="Archive chat"')
  })

  test("the active row gets the filled background", () => {
    expect(render({ isActive: true })).toContain("bg-muted")
  })
})
