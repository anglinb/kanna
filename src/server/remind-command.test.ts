import { describe, expect, test } from "bun:test"
import { REMINDERS_API_PATH_PREFIX, REMINDERS_API_TOKEN_HEADER } from "../shared/reminders"
import type { InstanceFile } from "./instance-file"
import { parseRemindArgs, runRemindCommand, type RemindArgs } from "./remind-command"

const NOW = 1_700_000_000_000

describe("parseRemindArgs", () => {
  test("reads a delay and a positional message", () => {
    expect(parseRemindArgs(["--in", "30m", "check the metrics"])).toEqual({
      clear: false,
      in: "30m",
      at: null,
      message: "check the metrics",
      chatId: null,
    })
  })

  test("reads the message from --message too", () => {
    expect(parseRemindArgs(["--in", "1h", "--message", "check"]).message).toBe("check")
  })

  test("reads --at", () => {
    const args = parseRemindArgs(["--at", "2030-01-01T09:00:00Z", "morning check"])
    expect(args.at).toBe("2030-01-01T09:00:00Z")
    expect(args.in).toBeNull()
  })

  test("reads --chat", () => {
    expect(parseRemindArgs(["--in", "5m", "--chat", "chat-9"]).chatId).toBe("chat-9")
  })

  test("--clear needs no time", () => {
    expect(parseRemindArgs(["--clear"])).toEqual({
      clear: true,
      in: null,
      at: null,
      message: null,
      chatId: null,
    })
    expect(parseRemindArgs(["--cancel"]).clear).toBe(true)
  })

  test("requires a time when not clearing", () => {
    expect(() => parseRemindArgs(["just do it"])).toThrow(/Say when/)
    expect(() => parseRemindArgs([])).toThrow(/Say when/)
  })

  test("rejects unknown flags", () => {
    expect(() => parseRemindArgs(["--in", "5m", "--wat"])).toThrow(/Unexpected argument/)
  })

  test("rejects a second positional", () => {
    expect(() => parseRemindArgs(["--in", "5m", "one", "two"])).toThrow(/Unexpected argument/)
  })

  test("rejects a flag with a missing value", () => {
    expect(() => parseRemindArgs(["--in"])).toThrow(/Missing value for --in/)
    expect(() => parseRemindArgs(["--in", "5m", "--chat"])).toThrow(/Missing value for --chat/)
  })
})

const INSTANCE: InstanceFile = {
  port: 3210,
  url: "http://127.0.0.1:3210",
  token: "instance-token",
  pid: 1234,
  instance: "test-instance",
  startedAt: NOW,
}

function createDeps(args: {
  response?: { status?: number; body: unknown }
  instance?: InstanceFile | null
  env?: Record<string, string | undefined>
} = {}) {
  const logs: string[] = []
  const warnings: string[] = []
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = []

  const deps = {
    log: (message: string) => logs.push(message),
    warn: (message: string) => warnings.push(message),
    cwd: () => "/repo",
    env: args.env ?? {},
    readInstance: async () => (args.instance === undefined ? INSTANCE : args.instance),
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push({
        url: String(url),
        headers,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      const status = args.response?.status ?? 200
      return new Response(JSON.stringify(args.response?.body ?? { ok: true, dueAt: NOW, delayMs: 60_000 }), {
        status,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch,
  }

  return { deps, logs, warnings, requests }
}

const SET_ARGS: RemindArgs = {
  clear: false,
  in: "30m",
  at: null,
  message: "check metrics",
  chatId: null,
}

describe("runRemindCommand", () => {
  test("posts to /set with the instance token and reports the schedule", async () => {
    const { deps, logs, requests } = createDeps({
      response: { body: { ok: true, dueAt: NOW, delayMs: 30 * 60_000, prompt: "check metrics" } },
    })

    const code = await runRemindCommand(SET_ARGS, deps)

    expect(code).toBe(0)
    expect(requests[0]?.url).toBe(`http://127.0.0.1:3210${REMINDERS_API_PATH_PREFIX}/set`)
    expect(requests[0]?.headers.get(REMINDERS_API_TOKEN_HEADER)).toBe("instance-token")
    expect(requests[0]?.body).toEqual({
      cwd: "/repo",
      chatId: null,
      in: "30m",
      at: null,
      prompt: "check metrics",
    })
    expect(logs.join("\n")).toContain("in 30m")
    // The line that stops the agent from sitting in a poll loop.
    expect(logs.join("\n")).toContain("end your turn")
  })

  test("carries KANNA_CHAT_ID when the provider set it", async () => {
    const { deps, requests } = createDeps({ env: { KANNA_CHAT_ID: "chat-env" } })
    await runRemindCommand(SET_ARGS, deps)
    expect(requests[0]?.body).toMatchObject({ chatId: "chat-env" })
  })

  test("an explicit --chat wins over the environment", async () => {
    const { deps, requests } = createDeps({ env: { KANNA_CHAT_ID: "chat-env" } })
    await runRemindCommand({ ...SET_ARGS, chatId: "chat-flag" }, deps)
    expect(requests[0]?.body).toMatchObject({ chatId: "chat-flag" })
  })

  test("says so when a prompt-less reminder will only resurface the chat", async () => {
    const { deps, logs } = createDeps({ response: { body: { ok: true, dueAt: NOW, delayMs: 60_000 } } })
    await runRemindCommand({ ...SET_ARGS, message: null }, deps)
    expect(logs.join("\n")).toContain("without starting a turn")
  })

  test("posts to /clear and says nothing about scheduling", async () => {
    const { deps, logs, requests } = createDeps({ response: { body: { ok: true, cleared: true } } })

    const code = await runRemindCommand(
      { clear: true, in: null, at: null, message: null, chatId: null },
      deps,
    )

    expect(code).toBe(0)
    expect(requests[0]?.url).toEndWith("/clear")
    expect(requests[0]?.body).toEqual({ cwd: "/repo", chatId: null })
    expect(logs).toEqual(["Reminder cancelled."])
  })

  test("reports the server's error and exits 1", async () => {
    const { deps, warnings } = createDeps({
      response: { status: 400, body: { error: "A reminder has to be in the future." } },
    })
    const code = await runRemindCommand(SET_ARGS, deps)
    expect(code).toBe(1)
    expect(warnings).toEqual(["A reminder has to be in the future."])
  })

  test("exits 1 with guidance when no server is running", async () => {
    const { deps, warnings } = createDeps({ instance: null })
    const code = await runRemindCommand(SET_ARGS, deps)
    expect(code).toBe(1)
    expect(warnings[0]).toContain("instance.json")
  })

  test("exits 1 when the server cannot be reached", async () => {
    const { deps, warnings } = createDeps()
    const code = await runRemindCommand(SET_ARGS, {
      ...deps,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    expect(code).toBe(1)
    expect(warnings[0]).toContain("ECONNREFUSED")
  })

  test("an overridden KANNA_URL uses its own explicit token", async () => {
    const { deps, requests } = createDeps({
      env: { KANNA_URL: "http://127.0.0.1:9999", KANNA_TOKEN: "explicit" },
    })
    await runRemindCommand(SET_ARGS, deps)
    expect(requests[0]?.url).toStartWith("http://127.0.0.1:9999")
    expect(requests[0]?.headers.get(REMINDERS_API_TOKEN_HEADER)).toBe("explicit")
  })

  test("refuses to send the instance token to an overridden KANNA_URL", async () => {
    const { deps, warnings, requests } = createDeps({
      env: { KANNA_URL: "http://evil.example" },
    })

    const code = await runRemindCommand(SET_ARGS, deps)

    expect(code).toBe(1)
    expect(requests).toEqual([])
    expect(warnings[0]).toContain("KANNA_TOKEN")
  })
})
