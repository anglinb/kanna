import { describe, expect, test } from "bun:test"
import { SECRETS_API_TOKEN_HEADER } from "../shared/secrets"
import {
  ASK_SECRET_DEFAULT_TIMEOUT_MS,
  parseAskSecretArgs,
  runAskSecretCommand,
  type AskSecretArgs,
} from "./ask-secret-command"

describe("parseAskSecretArgs", () => {
  test("takes the name positionally", () => {
    const args = parseAskSecretArgs(["OPENAI_API_KEY"])
    expect(args.name).toBe("OPENAI_API_KEY")
    expect(args.reason).toBe("")
    expect(args.scope).toBeNull()
    expect(args.force).toBe(false)
    expect(args.timeoutMs).toBe(ASK_SECRET_DEFAULT_TIMEOUT_MS)
  })

  test("parses every flag", () => {
    const args = parseAskSecretArgs([
      "TOKEN",
      "--reason",
      "deploy the app",
      "--scope",
      "global",
      "--timeout",
      "30",
      "--force",
    ])
    expect(args).toEqual({
      name: "TOKEN",
      reason: "deploy the app",
      scope: "global",
      timeoutMs: 30_000,
      force: true,
    })
  })

  test("requires a name", () => {
    expect(() => parseAskSecretArgs([])).toThrow(/Usage/)
  })

  test("rejects a name that could not be sourced into a shell", () => {
    expect(() => parseAskSecretArgs(["MY-KEY"])).toThrow(/Invalid secret name/)
    expect(() => parseAskSecretArgs(["../escape"])).toThrow(/Invalid secret name/)
  })

  test("rejects malformed flags", () => {
    expect(() => parseAskSecretArgs(["TOKEN", "--scope", "team"])).toThrow(/--scope/)
    expect(() => parseAskSecretArgs(["TOKEN", "--timeout", "soon"])).toThrow(/--timeout/)
    expect(() => parseAskSecretArgs(["TOKEN", "--reason"])).toThrow(/Missing value/)
    expect(() => parseAskSecretArgs(["TOKEN", "--nope"])).toThrow(/Unexpected argument/)
    expect(() => parseAskSecretArgs(["TOKEN", "EXTRA"])).toThrow(/Unexpected argument/)
  })
})

const baseArgs: AskSecretArgs = {
  name: "OPENAI_API_KEY",
  reason: "call the API",
  scope: null,
  timeoutMs: 10_000,
  force: false,
}

function harness(responses: Array<unknown>, options: { instance?: unknown } = {}) {
  const logs: string[] = []
  const warns: string[] = []
  const calls: Array<{ url: string; method: string; body?: string; token?: string | null }> = []
  let index = 0
  let clock = 0

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input as string, init)
    calls.push({
      url: request.url,
      method: request.method,
      body: init?.body ? String(init.body) : undefined,
      token: request.headers.get(SECRETS_API_TOKEN_HEADER),
    })
    const payload = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (payload instanceof Error) throw payload
    const { __status, ...body } = (payload ?? {}) as Record<string, unknown> & { __status?: number }
    return Response.json(body, { status: (__status as number) ?? 200 })
  }) as unknown as typeof fetch

  const deps = {
    log: (message: string) => logs.push(message),
    warn: (message: string) => warns.push(message),
    fetchImpl,
    sleep: async (ms: number) => {
      clock += ms
    },
    now: () => clock,
    cwd: () => "/tmp/proj",
    env: {} as Record<string, string | undefined>,
    readInstance: async () =>
      (options.instance === undefined
        ? { port: 3000, url: "http://127.0.0.1:3000", token: "tok", pid: 1, instance: "x", startedAt: 0 }
        : options.instance) as never,
  }

  return { logs, warns, calls, deps }
}

describe("runAskSecretCommand", () => {
  test("prints the load command when the secret is already stored", async () => {
    const { deps, logs } = harness([
      {
        status: "saved",
        existing: true,
        scope: "project",
        path: "/tmp/proj/.kanna/secrets/OPENAI_API_KEY.env",
        loadCommand: "set -a; . '/tmp/proj/.kanna/secrets/OPENAI_API_KEY.env'; set +a",
      },
    ])

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(0)
    const output = logs.join("\n")
    expect(output).toContain("already stored")
    expect(output).toContain("set -a; . '/tmp/proj/.kanna/secrets/OPENAI_API_KEY.env'; set +a")
    expect(output).toContain("Never cat, read, echo or grep the file")
  })

  test("polls a pending prompt until the user answers", async () => {
    const { deps, logs, calls } = harness([
      { status: "pending", requestId: "req-1" },
      { status: "pending" },
      { status: "pending" },
      {
        status: "saved",
        scope: "global",
        path: "/home/u/.kanna/secrets/OPENAI_API_KEY.env",
        loadCommand: "set -a; . '/home/u/.kanna/secrets/OPENAI_API_KEY.env'; set +a",
        gitignoreUpdated: false,
      },
    ])

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(0)
    expect(calls[0].method).toBe("POST")
    expect(calls[1].url).toContain("/requests/req-1")
    expect(calls).toHaveLength(4)
    expect(logs.join("\n")).toContain("saved (global scope)")
  })

  test("mentions the .gitignore edit when one happened", async () => {
    const { deps, logs } = harness([
      { status: "pending", requestId: "req-1" },
      { status: "saved", scope: "project", path: "/p/TOKEN.env", loadCommand: "load", gitignoreUpdated: true },
    ])

    await runAskSecretCommand(baseArgs, deps)
    expect(logs.join("\n")).toContain("Added .kanna/secrets/ to .gitignore")
  })

  test("exits 3 and says not to ask again when the user declines", async () => {
    const { deps, warns } = harness([
      { status: "pending", requestId: "req-1" },
      { status: "cancelled" },
    ])

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(3)
    expect(warns.join("\n")).toContain("declined")
    expect(warns.join("\n")).toContain("Do not ask again")
  })

  test("exits 2 when the prompt expires server-side", async () => {
    const { deps, warns } = harness([
      { status: "pending", requestId: "req-1" },
      { status: "expired" },
    ])

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(2)
    expect(warns.join("\n")).toContain("expired")
  })

  test("exits 2 on timeout and tells the agent re-running resumes the same prompt", async () => {
    const { deps, warns } = harness([
      { status: "pending", requestId: "req-1" },
      { status: "pending" },
    ])

    expect(await runAskSecretCommand({ ...baseArgs, timeoutMs: 3_000 }, deps)).toBe(2)
    expect(warns.join("\n")).toContain("still open")
    expect(warns.join("\n")).toContain("ask-secret OPENAI_API_KEY")
  })

  test("keeps waiting through a transient network blip", async () => {
    const { deps } = harness([
      { status: "pending", requestId: "req-1" },
      new Error("ECONNRESET"),
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(0)
  })

  test("reports a server-side rejection instead of polling forever", async () => {
    const { deps, warns } = harness([{ __status: 400, error: "Invalid secret name" }])

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(1)
    expect(warns.join("\n")).toContain("Invalid secret name")
  })

  test("explains itself when no server is running", async () => {
    const { deps, warns } = harness([], { instance: null })

    expect(await runAskSecretCommand(baseArgs, deps)).toBe(1)
    expect(warns.join("\n")).toContain("No running kanna server")
  })

  test("presents the instance token on every call", async () => {
    const { deps, calls } = harness([
      { status: "pending", requestId: "req-1" },
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])

    await runAskSecretCommand(baseArgs, deps)
    expect(calls.every((call) => call.token === "tok")).toBe(true)
  })

  test("sends the name, reason, cwd and flags the server needs", async () => {
    const { deps, calls } = harness([
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])

    await runAskSecretCommand({ ...baseArgs, scope: "global", force: true }, deps)
    expect(JSON.parse(calls[0].body!)).toEqual({
      name: "OPENAI_API_KEY",
      reason: "call the API",
      cwd: "/tmp/proj",
      scope: "global",
      force: true,
      chatId: null,
    })
  })

  test("forwards the chat id when the harness environment carries one", async () => {
    const { deps, calls } = harness([
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])

    await runAskSecretCommand(baseArgs, {
      ...deps,
      env: { ...deps.env, KANNA_CHAT_ID: "chat-42" },
    })
    expect(JSON.parse(calls[0].body!).chatId).toBe("chat-42")
  })

  test("environment overrides win over the instance file", async () => {
    const { deps, calls } = harness([
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])
    deps.env.KANNA_URL = "http://127.0.0.1:9999"
    deps.env.KANNA_TOKEN = "env-token"

    await runAskSecretCommand(baseArgs, deps)
    expect(calls[0].url).toStartWith("http://127.0.0.1:9999")
    expect(calls[0].token).toBe("env-token")
  })
})

describe("instance token handling", () => {
  test("does not send the instance token to an overridden KANNA_URL", async () => {
    const { deps, calls } = harness([
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])
    const warns: string[] = []

    const code = await runAskSecretCommand(baseArgs, {
      ...deps,
      warn: (message) => warns.push(message),
      env: { ...deps.env, KANNA_URL: "https://not-your-machine.example" },
    })

    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(warns.join("\n")).toContain("KANNA_TOKEN")
  })

  test("allows an overridden URL when its own token is supplied", async () => {
    const { deps, calls } = harness([
      { status: "saved", scope: "global", path: "/p/T.env", loadCommand: "load" },
    ])

    const code = await runAskSecretCommand(baseArgs, {
      ...deps,
      env: { ...deps.env, KANNA_URL: "http://127.0.0.1:9999", KANNA_TOKEN: "explicit" },
    })

    expect(code).toBe(0)
    expect(calls[0].token).toBe("explicit")
  })
})
