import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { createEmptyState } from "./events"

describe("read models", () => {
  test("includes the project folder modification time", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-mtime-"))
    const projectDir = path.join(tempRoot, "project")
    const modifiedAt = new Date("2026-07-15T14:30:00.000Z")

    try {
      mkdirSync(projectDir)
      utimesSync(projectDir, modifiedAt, modifiedAt)

      const snapshot = deriveLocalProjectsSnapshot(createEmptyState(), [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: 1,
      }], "Machine")

      expect(snapshot.projects[0]?.folderModifiedAt).toBe(modifiedAt.getTime())
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("hidden (dot-directory) discovered projects are filtered; saved ones are kept", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/home/user/.dotfiles",
      title: "dotfiles",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/home/user/.dotfiles", "project-1")

    const snapshot = deriveLocalProjectsSnapshot(state, [
      { localPath: "/home/user/.claude/scratch", title: "scratch", modifiedAt: 2 },
      { localPath: "/home/user/work/.hidden-repo", title: "hidden-repo", modifiedAt: 3 },
      { localPath: "/home/user/work/visible", title: "visible", modifiedAt: 4 },
    ], "Machine")

    const paths = snapshot.projects.map((project) => project.localPath)
    expect(paths).toContain("/home/user/work/visible")
    // Saved projects are exempt — the user opted in explicitly.
    expect(paths).toContain("/home/user/.dotfiles")
    expect(paths).not.toContain("/home/user/.claude/scratch")
    expect(paths).not.toContain("/home/user/work/.hidden-repo")
  })

  test("Codex scratch workspaces are filtered; saved ones and real projects are kept", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/home/user/Documents/Codex/2026-07-11/kept-because-saved",
      title: "kept-because-saved",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/home/user/Documents/Codex/2026-07-11/kept-because-saved", "project-1")

    const snapshot = deriveLocalProjectsSnapshot(state, [
      { localPath: "/home/user/Documents/Codex/2026-07-11/what", title: "what", modifiedAt: 2 },
      { localPath: "/home/user/Documents/Codex/2026-07-11", title: "2026-07-11", modifiedAt: 3 },
      { localPath: "/home/user/Documents/Codex/2026-06-18/can/nested", title: "nested", modifiedAt: 4 },
      // Non-default root: the app offers no setting for it, so match structurally.
      { localPath: "/Volumes/work/Codex/2026-07-12/scratch", title: "scratch", modifiedAt: 5 },
      // The workspace root itself may be the user's own folder — keep it.
      { localPath: "/home/user/Documents/Codex", title: "Codex", modifiedAt: 6 },
      // A real project that merely lives near/under a Codex-ish name.
      { localPath: "/home/user/code/codex-clone", title: "codex-clone", modifiedAt: 7 },
      { localPath: "/home/user/code/Codex/packages/core", title: "core", modifiedAt: 8 },
    ], "Machine")

    const paths = snapshot.projects.map((project) => project.localPath)
    expect(paths).not.toContain("/home/user/Documents/Codex/2026-07-11/what")
    expect(paths).not.toContain("/home/user/Documents/Codex/2026-07-11")
    expect(paths).not.toContain("/home/user/Documents/Codex/2026-06-18/can/nested")
    expect(paths).not.toContain("/Volumes/work/Codex/2026-07-12/scratch")
    expect(paths).toContain("/home/user/Documents/Codex")
    expect(paths).toContain("/home/user/code/codex-clone")
    expect(paths).toContain("/home/user/code/Codex/packages/core")
    // Saved projects are exempt — the user opted in explicitly.
    expect(paths).toContain("/home/user/Documents/Codex/2026-07-11/kept-because-saved")
  })

  test("include provider data in sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: true,
      provider: "codex",
      planMode: false,
      autoPlan: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })
    expect(sidebar.projectGroups[0]?.title).toBe("Project")
    expect(sidebar.projectGroups[0]?.localPath).toBe("/tmp/project")
    expect(sidebar.projectGroups[0]?.chats[0]?.provider).toBe("codex")
    expect(sidebar.projectGroups[0]?.chats[0]?.unread).toBe(true)
    expect(sidebar.projectGroups[0]?.chats[0]?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats).toEqual([])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("uses sidebar-only project titles without changing local project metadata", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      sidebarTitle: "Sidebar Name",
      createdAt: 1,
      updatedAt: 2,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")

    expect(deriveSidebarData(state, new Map()).projectGroups[0]?.title).toBe("Sidebar Name")
    expect(deriveLocalProjectsSnapshot(state, [], "Machine").projects[0]?.title).toBe("Project")
  })

  test("keeps archived chats out of the main sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-active", {
      id: "chat-active",
      projectId: "project-1",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-archived", {
      id: "chat-archived",
      projectId: "project-1",
      title: "Archived",
      createdAt: 2,
      updatedAt: 3,
      archivedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
      hasMessages: true,
      lastMessageAt: 3,
    })
    // Archived chats that never got a message are hidden from every surface.
    state.chatsById.set("chat-archived-empty", {
      id: "chat-archived-empty",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 2,
      updatedAt: 3,
      archivedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-active"])
    expect(sidebar.projectGroups[0]?.archivedChats?.map((chat) => chat.chatId)).toEqual(["chat-archived"])
  })

  test("includes available providers in chat snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: true,
      autoPlan: false,
      sessionToken: "session-1",
      lastTurnOutcome: null,
    })
    state.queuedMessagesByChatId.set("chat-1", [{
      id: "queued-1",
      content: "follow up",
      attachments: [],
      createdAt: 2,
      provider: "claude",
      model: "claude-sonnet-4-6",
      planMode: true,
      autoPlan: false,
    }])

    const chat = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      "chat-1",
      () => ({
        messages: [],
        history: {
          hasOlder: false,
          olderCursor: null,
          recentLimit: 200,
        },
        readAnchor: null,
        startIndex: 0,
      })
    )
    expect(chat?.runtime.provider).toBe("claude")
    expect(chat?.queuedMessages.map((message) => message.content)).toEqual(["follow up"])
    expect(chat?.history.recentLimit).toBe(200)
    expect(chat?.availableProviders.length).toBeGreaterThan(1)
    expect(chat?.availableProviders.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ])
  })

  test("prefers saved project metadata over discovered entries for the same path", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Saved Project",
      createdAt: 1,
      updatedAt: 50,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 75,
      unread: false,
      provider: "codex",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })

    const snapshot = deriveLocalProjectsSnapshot(state, [
      {
        localPath: "/tmp/project",
        title: "Discovered Project",
        modifiedAt: 10,
      },
    ], "Local Machine")

    expect(snapshot.projects).toEqual([
      {
        localPath: "/tmp/project",
        title: "Saved Project",
        source: "saved",
        lastOpenedAt: 100,
        chatCount: 1,
      },
    ])
  })

  test("orders sidebar chats by user-visible activity instead of internal updatedAt churn", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-old", {
      id: "chat-old",
      projectId: "project-1",
      title: "Older user activity",
      createdAt: 10,
      updatedAt: 500,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-new", {
      id: "chat-new",
      projectId: "project-1",
      title: "Newer user activity",
      createdAt: 20,
      updatedAt: 50,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 200,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())
    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-new", "chat-old"])
  })

  test("honors persisted project order before fallback updated-at ordering", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project-1",
      title: "One",
      createdAt: 1,
      updatedAt: 10,
    })
    state.projectsById.set("project-2", {
      id: "project-2",
      localPath: "/tmp/project-2",
      title: "Two",
      createdAt: 2,
      updatedAt: 20,
    })
    state.projectsById.set("project-3", {
      id: "project-3",
      localPath: "/tmp/project-3",
      title: "Three",
      createdAt: 3,
      updatedAt: 15,
    })
    const sidebar = deriveSidebarData(state, new Map(), { sidebarProjectOrder: ["project-1"] })

    expect(sidebar.projectGroups.map((group) => group.groupKey)).toEqual(["project-1", "project-2", "project-3"])
  })

  test("builds preview and older chat slices using the current sidebar rules", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Recent",
      createdAt: 10,
      updatedAt: 10,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "Older",
      createdAt: 20,
      updatedAt: 20,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 26 * 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual(["chat-2"])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("folds done chats below the preview even when they are recent", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Recent",
      createdAt: 10,
      updatedAt: 10,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "Recent but done",
      createdAt: 20,
      updatedAt: 20,
      doneAt: 1_000_000 - 30 * 60 * 1_000,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 30 * 60 * 1_000,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual(["chat-2"])
    expect(sidebar.projectGroups[0]?.olderChats[0]?.done).toBe(true)
  })

  test("shows all recent chats in the preview before folding older chats", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")

    for (let index = 0; index < 6; index++) {
      const chatNumber = index + 1
      state.chatsById.set(`chat-${chatNumber}`, {
        id: `chat-${chatNumber}`,
        projectId: "project-1",
        title: `Chat ${chatNumber}`,
        createdAt: chatNumber,
        updatedAt: chatNumber,
        unread: false,
        provider: "claude",
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastMessageAt: 1_000_000 - chatNumber * 60 * 1_000,
        lastTurnOutcome: null,
      })
    }

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
      "chat-4",
      "chat-5",
      "chat-6",
    ])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual([])
  })

  test("disables forking for active and draining chats, but allows pending fork chats", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-active", {
      id: "chat-active",
      projectId: "project-1",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: "session-active",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-pending", {
      id: "chat-pending",
      projectId: "project-1",
      title: "Pending fork",
      createdAt: 2,
      updatedAt: 2,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      pendingForkSessionToken: "session-parent",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-draining", {
      id: "chat-draining",
      projectId: "project-1",
      title: "Draining",
      createdAt: 3,
      updatedAt: 3,
      unread: false,
      provider: "codex",
      planMode: false,
      autoPlan: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-cursor", {
      id: "chat-cursor",
      projectId: "project-1",
      title: "Cursor",
      createdAt: 4,
      updatedAt: 4,
      unread: false,
      provider: "cursor",
      planMode: false,
      autoPlan: false,
      sessionToken: "cursor-session",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(
      state,
      new Map([["chat-active", "running"]]),
      { drainingChatIds: new Set(["chat-draining"]) }
    )

    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-active")?.canFork).toBeUndefined()
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-pending")?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-draining")?.canFork).toBeUndefined()
    // Cursor has no fork primitive, so forking is disabled even with a live session.
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-cursor")?.canFork).toBeUndefined()
  })

  describe("uncommittedWork", () => {
    const DIRTY_SINCE_MS = 10_000

    function stateWithChats(chats: Array<{ id: string; lastTurnEndedAt?: number }>) {
      const state = createEmptyState()
      state.projectsById.set("project-1", {
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 1,
      })
      state.projectIdsByPath.set("/tmp/project", "project-1")
      for (const chat of chats) {
        state.chatsById.set(chat.id, {
          id: chat.id,
          projectId: "project-1",
          title: chat.id,
          createdAt: 1,
          updatedAt: 1,
          unread: false,
          provider: "claude",
          planMode: false,
          autoPlan: false,
          sessionToken: null,
          lastTurnOutcome: null,
          ...(chat.lastTurnEndedAt == null ? {} : { lastTurnEndedAt: chat.lastTurnEndedAt }),
        })
      }
      return state
    }

    function rowsFor(
      chats: Array<{ id: string; lastTurnEndedAt?: number }>,
      workingTrees?: Map<string, { dirty: boolean; dirtySinceMs?: number }>
    ) {
      const sidebar = deriveSidebarData(stateWithChats(chats), new Map(), {
        nowMs: 1_000_000,
        ...(workingTrees ? { workingTrees } : {}),
      })
      return sidebar.projectGroups[0]?.chats ?? []
    }

    test("flags a chat whose last turn ended after the tree became dirty", () => {
      const rows = rowsFor(
        [{ id: "chat-after", lastTurnEndedAt: DIRTY_SINCE_MS + 1 }],
        new Map([["project-1", { dirty: true, dirtySinceMs: DIRTY_SINCE_MS }]])
      )

      expect(rows[0]?.uncommittedWork).toBe(true)
    })

    test("leaves a chat whose last turn predates the dirt unflagged", () => {
      const rows = rowsFor(
        [{ id: "chat-before", lastTurnEndedAt: DIRTY_SINCE_MS - 1 }],
        new Map([["project-1", { dirty: true, dirtySinceMs: DIRTY_SINCE_MS }]])
      )

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("flags nothing when the tree is clean", () => {
      const rows = rowsFor(
        [{ id: "chat-1", lastTurnEndedAt: DIRTY_SINCE_MS + 1 }],
        new Map([["project-1", { dirty: false }]])
      )

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("flags nothing when the tree is dirty but unanchored", () => {
      // Deletion-only trees have nothing to stat, so there is no anchor to
      // compare against and we must not guess.
      const rows = rowsFor(
        [{ id: "chat-1", lastTurnEndedAt: DIRTY_SINCE_MS + 1 }],
        new Map([["project-1", { dirty: true }]])
      )

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("leaves a chat that never finished a turn unflagged", () => {
      const rows = rowsFor(
        [{ id: "chat-no-turn" }],
        new Map([["project-1", { dirty: true, dirtySinceMs: DIRTY_SINCE_MS }]])
      )

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("flags nothing when the project has no probe entry yet", () => {
      const rows = rowsFor([{ id: "chat-1", lastTurnEndedAt: DIRTY_SINCE_MS + 1 }], new Map())

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("omits the field entirely rather than emitting false", () => {
      const rows = rowsFor([{ id: "chat-1", lastTurnEndedAt: DIRTY_SINCE_MS - 1 }], new Map([
        ["project-1", { dirty: true, dirtySinceMs: DIRTY_SINCE_MS }],
      ]))

      // The sidebar dedupe signature is a JSON.stringify of the whole snapshot,
      // so an always-present `false` would be pure wire noise.
      expect("uncommittedWork" in (rows[0] ?? {})).toBe(false)
    })

    test("flags every qualifying chat in the project, not just one", () => {
      const rows = rowsFor(
        [
          { id: "chat-a", lastTurnEndedAt: DIRTY_SINCE_MS + 1 },
          { id: "chat-b", lastTurnEndedAt: DIRTY_SINCE_MS + 2 },
          { id: "chat-c", lastTurnEndedAt: DIRTY_SINCE_MS - 1 },
        ],
        new Map([["project-1", { dirty: true, dirtySinceMs: DIRTY_SINCE_MS }]])
      )

      const flagged = rows.filter((row) => row.uncommittedWork).map((row) => row.chatId).sort()
      expect(flagged).toEqual(["chat-a", "chat-b"])
    })
  })
})
