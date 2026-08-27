import { describe, expect, test } from "bun:test"
import { REMINDERS_API_PATH_PREFIX, REMINDERS_API_TOKEN_HEADER } from "../shared/reminders"
import { createRemindersApi } from "./reminders-api"

const TOKEN = "correct-horse-battery-staple"
const NOW = 1_700_000_000_000

function createApi(args: {
  resolveChat?: (args: { cwd: string; claimedChatId: string | null }) => string | null
} = {}) {
  const setCalls: Array<{ chatId: string; dueAt: number; prompt?: string }> = []
  const clearCalls: string[] = []
  let changedCount = 0

  const handler = createRemindersApi({
    token: TOKEN,
    resolveChat: args.resolveChat ?? (({ claimedChatId }) => claimedChatId ?? "chat-1"),
    setReminder: async (chatId, reminderArgs) => {
      setCalls.push({ chatId, ...reminderArgs })
    },
    clearReminder: async (chatId) => {
      clearCalls.push(chatId)
    },
    onChanged: () => {
      changedCount += 1
    },
    now: () => NOW,
  })

  async function call(subPath: string, init: RequestInit & { token?: string | null } = {}) {
    const url = new URL(`http://127.0.0.1:3210${REMINDERS_API_PATH_PREFIX}${subPath}`)
    const headers = new Headers(init.headers)
    headers.set("content-type", "application/json")
    const token = init.token === undefined ? TOKEN : init.token
    if (token !== null) headers.set(REMINDERS_API_TOKEN_HEADER, token)
    const request = new Request(url, { method: init.method ?? "POST", headers, body: init.body })
    return handler(request, url)
  }

  return { call, setCalls, clearCalls, changed: () => changedCount }
}

describe("routing", () => {
  test("returns null for paths that are not ours, so routing falls through", async () => {
    const { call } = createApi()
    const url = new URL("http://127.0.0.1:3210/api/something")
    const handler = createRemindersApi({
      token: TOKEN,
      resolveChat: () => "chat-1",
      setReminder: async () => {},
      clearReminder: async () => {},
      onChanged: () => {},
    })
    expect(await handler(new Request(url), url)).toBeNull()
    // Sanity: our own prefix does not return null.
    expect(await call("/set", { body: JSON.stringify({ in: "30m" }) })).not.toBeNull()
  })

  test("404s an unknown sub-path", async () => {
    const { call } = createApi()
    const response = await call("/explode", { body: "{}" })
    expect(response?.status).toBe(404)
  })

  test("405s a non-POST", async () => {
    const { call } = createApi()
    const response = await call("/set", { method: "GET" })
    expect(response?.status).toBe(405)
  })
})

describe("auth", () => {
  test("rejects a missing token", async () => {
    const { call } = createApi()
    const response = await call("/set", { token: null, body: JSON.stringify({ in: "30m" }) })
    expect(response?.status).toBe(401)
  })

  test("rejects a wrong token", async () => {
    const { call } = createApi()
    const response = await call("/set", { token: "nope", body: JSON.stringify({ in: "30m" }) })
    expect(response?.status).toBe(401)
  })

  test("rejects a token of a different length without throwing", async () => {
    const { call } = createApi()
    const response = await call("/set", { token: "short", body: JSON.stringify({ in: "30m" }) })
    expect(response?.status).toBe(401)
  })
})

describe("setting a reminder", () => {
  test("resolves a relative delay against the server clock", async () => {
    const { call, setCalls, changed } = createApi()
    const response = await call("/set", {
      body: JSON.stringify({ in: "30m", prompt: "check metrics", chatId: "chat-7" }),
    })

    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({
      ok: true,
      dueAt: NOW + 30 * 60_000,
      delayMs: 30 * 60_000,
      prompt: "check metrics",
    })
    expect(setCalls).toEqual([{
      chatId: "chat-7",
      dueAt: NOW + 30 * 60_000,
      prompt: "check metrics",
    }])
    expect(changed()).toBe(1)
  })

  test("accepts an absolute time", async () => {
    const { call, setCalls } = createApi()
    const at = new Date(NOW + 3_600_000).toISOString()
    await call("/set", { body: JSON.stringify({ at }) })
    expect(setCalls[0]?.dueAt).toBe(NOW + 3_600_000)
  })

  test("omits the prompt entirely when none is given", async () => {
    const { call, setCalls } = createApi()
    await call("/set", { body: JSON.stringify({ in: "1h" }) })
    expect(setCalls[0]).toEqual({ chatId: "chat-1", dueAt: NOW + 3_600_000 })
    expect("prompt" in (setCalls[0] ?? {})).toBe(false)
  })

  test("treats a whitespace-only prompt as no prompt", async () => {
    const { call, setCalls } = createApi()
    await call("/set", { body: JSON.stringify({ in: "1h", prompt: "   " }) })
    expect("prompt" in (setCalls[0] ?? {})).toBe(false)
  })

  test("rejects a time in the past", async () => {
    const { call, setCalls } = createApi()
    const response = await call("/set", {
      body: JSON.stringify({ at: new Date(NOW - 1_000).toISOString() }),
    })
    expect(response?.status).toBe(400)
    expect(setCalls).toEqual([])
  })

  test("rejects an unreadable delay and says so", async () => {
    const { call } = createApi()
    const response = await call("/set", { body: JSON.stringify({ in: "whenever" }) })
    expect(response?.status).toBe(400)
    expect((await response?.json())?.error).toContain("whenever")
  })

  test("rejects a body that is not JSON", async () => {
    const { call } = createApi()
    const response = await call("/set", { body: "not json" })
    expect(response?.status).toBe(400)
  })
})

describe("clearing a reminder", () => {
  test("clears and broadcasts", async () => {
    const { call, clearCalls, changed } = createApi()
    const response = await call("/clear", { body: JSON.stringify({ chatId: "chat-3" }) })
    expect(await response?.json()).toEqual({ ok: true, cleared: true })
    expect(clearCalls).toEqual(["chat-3"])
    expect(changed()).toBe(1)
  })
})

describe("chat resolution", () => {
  test("400s with guidance when the chat cannot be resolved", async () => {
    const { call, setCalls } = createApi({ resolveChat: () => null })
    const response = await call("/set", { body: JSON.stringify({ in: "30m" }) })
    expect(response?.status).toBe(400)
    expect((await response?.json())?.error).toContain("--chat")
    expect(setCalls).toEqual([])
  })

  test("passes the claimed chat id and cwd through to the resolver", async () => {
    const seen: Array<{ cwd: string; claimedChatId: string | null }> = []
    const { call } = createApi({
      resolveChat: (resolveArgs) => {
        seen.push(resolveArgs)
        return "chat-9"
      },
    })
    await call("/set", { body: JSON.stringify({ in: "5m", cwd: "/repo", chatId: "chat-4" }) })
    expect(seen).toEqual([{ cwd: "/repo", claimedChatId: "chat-4" }])
  })

  test("treats a blank claimed chat id as absent", async () => {
    const seen: Array<{ cwd: string; claimedChatId: string | null }> = []
    const { call } = createApi({
      resolveChat: (resolveArgs) => {
        seen.push(resolveArgs)
        return "chat-9"
      },
    })
    await call("/set", { body: JSON.stringify({ in: "5m", cwd: "/repo", chatId: "  " }) })
    expect(seen[0]?.claimedChatId).toBeNull()
  })
})
