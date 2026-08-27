import { describe, expect, test } from "bun:test"
import type { ChatReminder } from "../shared/reminders"
import type { ChatRecord } from "./events"
import { ReminderScheduler } from "./reminder-scheduler"

const NOW = 1_700_000_000_000

function chat(id: string): ChatRecord {
  return {
    id,
    projectId: "project-1",
    title: id,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    unread: false,
    provider: null,
    planMode: false,
    autoPlan: false,
    sessionToken: null,
    lastTurnOutcome: null,
  }
}

function createScheduler(args: {
  reminders: Array<{ chat: ChatRecord; reminder: ChatReminder }>
  now?: number
  postPrompt?: (chatId: string, prompt: string) => Promise<void>
  clearReminder?: (chatId: string) => Promise<void>
}) {
  const cleared: string[] = []
  const unread: string[] = []
  const posted: Array<{ chatId: string; prompt: string }> = []
  const notices: Array<{ chatId: string; scheduledAt: number; createdBy: string; wokeAgent: boolean }> = []
  /** Every side effect in fire order, so ordering can be asserted directly. */
  const order: string[] = []
  let changedCount = 0

  const rows = [...args.reminders]

  const scheduler = new ReminderScheduler({
    // A fresh array per call, like `listChatsWithReminders` — clearing during
    // a tick must not mutate the list that tick is iterating.
    listReminders: () => [...rows],
    clearReminder: async (chatId) => {
      if (args.clearReminder) await args.clearReminder(chatId)
      cleared.push(chatId)
      order.push("clear")
      // Mirror the store: a cleared reminder leaves the work list.
      const index = rows.findIndex((row) => row.chat.id === chatId)
      if (index >= 0) rows.splice(index, 1)
    },
    markUnread: async (chatId) => {
      unread.push(chatId)
      order.push("unread")
    },
    recordNotice: async (chatId, notice) => {
      notices.push({ chatId, ...notice })
      order.push("notice")
    },
    postPrompt: async (chatId, prompt) => {
      order.push("prompt")
      if (args.postPrompt) return args.postPrompt(chatId, prompt)
      posted.push({ chatId, prompt })
    },
    onChanged: () => {
      changedCount += 1
    },
    now: () => args.now ?? NOW,
  })

  return {
    scheduler,
    cleared,
    unread,
    posted,
    notices,
    order,
    changed: () => changedCount,
  }
}

describe("firing", () => {
  test("fires a due reminder: clears it, marks unread, posts the prompt", async () => {
    const harness = createScheduler({
      reminders: [{
        chat: chat("chat-1"),
        reminder: { dueAt: NOW - 1, createdAt: NOW - 1_000, createdBy: "user", prompt: "check metrics" },
      }],
    })

    await harness.scheduler.tick()

    expect(harness.cleared).toEqual(["chat-1"])
    expect(harness.unread).toEqual(["chat-1"])
    expect(harness.posted).toEqual([{ chatId: "chat-1", prompt: "check metrics" }])
    expect(harness.changed()).toBe(1)
    // The divider must land before the prompt it introduces, or the transcript
    // reads as though the reminder answered the message.
    expect(harness.order).toEqual(["clear", "unread", "notice", "prompt"])
    expect(harness.notices).toEqual([{
      chatId: "chat-1",
      scheduledAt: NOW - 1_000,
      createdBy: "user",
      wokeAgent: true,
    }])
  })

  test("a reminder with no prompt only resurfaces the chat", async () => {
    const harness = createScheduler({
      reminders: [{
        chat: chat("chat-1"),
        reminder: { dueAt: NOW - 1, createdAt: NOW - 1_000, createdBy: "agent" },
      }],
    })

    await harness.scheduler.tick()

    expect(harness.unread).toEqual(["chat-1"])
    expect(harness.posted).toEqual([])
    // Still gets a divider — the chat resurfaced for a reason worth recording.
    expect(harness.notices[0]).toMatchObject({ createdBy: "agent", wokeAgent: false })
  })

  test("leaves reminders that are not yet due alone", async () => {
    const harness = createScheduler({
      reminders: [{
        chat: chat("chat-1"),
        reminder: { dueAt: NOW + 60_000, createdAt: NOW, createdBy: "user", prompt: "later" },
      }],
    })

    await harness.scheduler.tick()

    expect(harness.cleared).toEqual([])
    expect(harness.posted).toEqual([])
    expect(harness.changed()).toBe(0)
  })

  test("fires a reminder that came due while the server was down", async () => {
    const harness = createScheduler({
      reminders: [{
        chat: chat("chat-1"),
        // Set a week ago for six days ago: late, but not dropped.
        reminder: {
          dueAt: NOW - 6 * 86_400_000,
          createdAt: NOW - 7 * 86_400_000,
          createdBy: "user",
          prompt: "still relevant",
        },
      }],
    })

    await harness.scheduler.tick()

    expect(harness.posted).toEqual([{ chatId: "chat-1", prompt: "still relevant" }])
  })

  test("fires several due reminders in one tick, broadcasting once", async () => {
    const harness = createScheduler({
      reminders: [
        {
          chat: chat("chat-1"),
          reminder: { dueAt: NOW - 1, createdAt: NOW - 10, createdBy: "user", prompt: "one" },
        },
        {
          chat: chat("chat-2"),
          reminder: { dueAt: NOW - 2, createdAt: NOW - 10, createdBy: "agent", prompt: "two" },
        },
      ],
    })

    await harness.scheduler.tick()

    expect(harness.posted.map((entry) => entry.chatId)).toEqual(["chat-1", "chat-2"])
    expect(harness.changed()).toBe(1)
  })
})

describe("failure handling", () => {
  test("a failed post still spends the reminder, so it cannot re-fire forever", async () => {
    const harness = createScheduler({
      reminders: [{
        chat: chat("chat-1"),
        reminder: { dueAt: NOW - 1, createdAt: NOW - 10, createdBy: "user", prompt: "boom" },
      }],
      postPrompt: async () => {
        throw new Error("agent unavailable")
      },
    })

    await harness.scheduler.tick()

    expect(harness.cleared).toEqual(["chat-1"])
    // Second tick has nothing left to do.
    await harness.scheduler.tick()
    expect(harness.cleared).toEqual(["chat-1"])
  })

  test("a failure on one chat does not stop the others", async () => {
    const harness = createScheduler({
      reminders: [
        {
          chat: chat("chat-1"),
          reminder: { dueAt: NOW - 1, createdAt: NOW - 10, createdBy: "user", prompt: "boom" },
        },
        {
          chat: chat("chat-2"),
          reminder: { dueAt: NOW - 1, createdAt: NOW - 10, createdBy: "user", prompt: "fine" },
        },
      ],
      postPrompt: async (chatId, prompt) => {
        if (chatId === "chat-1") throw new Error("nope")
        expect(prompt).toBe("fine")
      },
    })

    await harness.scheduler.tick()

    expect(harness.cleared).toEqual(["chat-1", "chat-2"])
  })

  test("a reminder that fails to clear is not posted", async () => {
    const harness = createScheduler({
      reminders: [{
        chat: chat("chat-1"),
        reminder: { dueAt: NOW - 1, createdAt: NOW - 10, createdBy: "user", prompt: "check" },
      }],
      clearReminder: async () => {
        throw new Error("disk full")
      },
    })

    await harness.scheduler.tick()

    expect(harness.posted).toEqual([])
    expect(harness.unread).toEqual([])
    expect(harness.notices).toEqual([])
  })
})

describe("lifecycle", () => {
  test("start is idempotent and stop clears the timer", () => {
    const harness = createScheduler({ reminders: [] })
    harness.scheduler.start()
    harness.scheduler.start()
    harness.scheduler.stop()
    harness.scheduler.stop()
  })
})
