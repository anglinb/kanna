/**
 * End-to-end for ask-for-secret, everything but the browser: the real CLI
 * talks real HTTP to the real API handler, a simulated UI answers the prompt,
 * and the assertions land on the actual file written to disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runAskSecretCommand, type AskSecretDeps } from "./ask-secret-command"
import { SecretRequestStore } from "./secret-requests"
import { createSecretsApi, resolveProjectFromCwd } from "./secrets-api"

const TOKEN = "integration-token"

let project: string
let requests: SecretRequestStore
let server: ReturnType<typeof Bun.serve>
let logs: string[]
let warns: string[]

/** Bun types `server.port` as optional; a listening test server always has one. */
function servedPort(): number {
  const port = server.port
  if (port === undefined) throw new Error("test server is not listening")
  return port
}

function deps(overrides: Partial<AskSecretDeps> = {}): AskSecretDeps {
  return {
    log: (message) => logs.push(message),
    warn: (message) => warns.push(message),
    cwd: () => project,
    env: {},
    readInstance: async () => ({
      port: servedPort(),
      url: `http://127.0.0.1:${servedPort()}`,
      token: TOKEN,
      pid: process.pid,
      instance: "test",
      startedAt: 0,
    }),
    ...overrides,
  }
}

/** Poll the store the way the UI's snapshot subscription would, then answer. */
async function answerWhenPrompted(answer: { scope: "project" | "global"; value: string }) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [pending] = requests.list()
    if (pending) {
      return requests.submit(pending.id, answer)
    }
    await Bun.sleep(10)
  }
  throw new Error("no prompt ever appeared")
}

beforeEach(async () => {
  logs = []
  warns = []
  project = await mkdtemp(path.join(tmpdir(), "kanna-ask-secret-e2e-"))
  await mkdir(path.join(project, ".git"))

  requests = new SecretRequestStore()
  const handle = createSecretsApi({
    requests,
    token: TOKEN,
    resolveProject: (cwd) => resolveProjectFromCwd(cwd, [{ path: project, title: "demo" }]),
  })

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      return (await handle(req, url)) ?? new Response("Not found", { status: 404 })
    },
  })
})

afterEach(async () => {
  server.stop(true)
  requests.dispose()
  await rm(project, { recursive: true, force: true })
})

describe("ask-secret end to end", () => {
  test("agent asks, user answers, secret lands on disk and only the load command is printed", async () => {
    const run = runAskSecretCommand(
      { name: "OPENAI_API_KEY", reason: "call the API", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    await answerWhenPrompted({ scope: "project", value: "sk-super-secret-value" })

    expect(await run).toBe(0)

    const secretPath = path.join(project, ".kanna", "secrets", "OPENAI_API_KEY.env")
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(secretPath, "utf8")).toContain("OPENAI_API_KEY='sk-super-secret-value'")

    const output = [...logs, ...warns].join("\n")
    expect(output).toContain(`set -a; . '${secretPath}'; set +a`)
    // The whole point: the value never reaches the agent's stdout.
    expect(output).not.toContain("sk-super-secret-value")
  })

  test("the written file actually loads in a real shell", async () => {
    const run = runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    await answerWhenPrompted({ scope: "project", value: "pa'ss w$rd`x`" })
    expect(await run).toBe(0)

    const loadLine = logs.find((line) => line.includes("set -a"))!.trim()
    const shell = Bun.spawnSync(["sh", "-c", `${loadLine}; printf '%s' "$TOKEN"`])

    expect(shell.exitCode).toBe(0)
    expect(shell.stdout.toString()).toBe("pa'ss w$rd`x`")
  })

  test("project scope adds the gitignore entry exactly once", async () => {
    const first = runAskSecretCommand(
      { name: "ONE", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    await answerWhenPrompted({ scope: "project", value: "a" })
    await first

    const second = runAskSecretCommand(
      { name: "TWO", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    await answerWhenPrompted({ scope: "project", value: "b" })
    await second

    const gitignore = await readFile(path.join(project, ".gitignore"), "utf8")
    expect(gitignore.match(/\.kanna\/secrets\//g)).toHaveLength(1)
  })

  test("a second ask for a stored secret answers instantly, without prompting", async () => {
    const first = runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    await answerWhenPrompted({ scope: "project", value: "v" })
    await first

    logs = []
    const code = await runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )

    expect(code).toBe(0)
    expect(logs.join("\n")).toContain("already stored")
    expect(requests.list()).toHaveLength(0)
  })

  test("declining reports exit 3 and writes nothing", async () => {
    const run = runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )

    for (let attempt = 0; attempt < 200 && requests.list().length === 0; attempt += 1) {
      await Bun.sleep(10)
    }
    requests.cancel(requests.list()[0].id)

    expect(await run).toBe(3)
    expect(warns.join("\n")).toContain("declined")
    await expect(stat(path.join(project, ".kanna", "secrets", "TOKEN.env"))).rejects.toThrow()
  })

  test("a re-run while a prompt is open joins it instead of stacking a second one", async () => {
    const first = runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    for (let attempt = 0; attempt < 200 && requests.list().length === 0; attempt += 1) {
      await Bun.sleep(10)
    }

    const second = runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 15_000, force: false },
      deps(),
    )
    await Bun.sleep(50)
    expect(requests.list()).toHaveLength(1)

    // Project scope throughout: a global-scope answer would write into the
    // real ~/.kanna/secrets on the machine running the suite.
    await answerWhenPrompted({ scope: "project", value: "shared" })
    expect(await first).toBe(0)
    expect(await second).toBe(0)
  })

  test("an unauthenticated caller gets nowhere", async () => {
    const code = await runAskSecretCommand(
      { name: "TOKEN", reason: "", scope: null, timeoutMs: 5_000, force: false },
      deps({
        readInstance: async () => ({
          port: servedPort(),
          url: `http://127.0.0.1:${servedPort()}`,
          token: "wrong-token",
          pid: 0,
          instance: "",
          startedAt: 0,
        }),
      }),
    )

    expect(code).toBe(1)
    expect(requests.list()).toHaveLength(0)
  })
})
