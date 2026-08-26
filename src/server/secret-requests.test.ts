import { describe, expect, test } from "bun:test"
import {
  SECRET_REQUEST_TTL_MS,
  SECRET_RESOLUTION_RETENTION_MS,
  SecretRequestStore,
} from "./secret-requests"
import type { writeSecret } from "./secrets"

function createStore(options: { now?: () => number } = {}) {
  const written: Array<{ scope: string; name: string; value: string; projectPath?: string | null }> = []
  const fakeWrite: typeof writeSecret = async (args) => {
    written.push({ ...args })
    return {
      scope: args.scope,
      name: args.name,
      path: `/tmp/${args.name}.env`,
      loadCommand: `set -a; . '/tmp/${args.name}.env'; set +a`,
      gitignoreUpdated: args.scope === "project",
    }
  }

  return {
    written,
    store: new SecretRequestStore({ writeSecret: fakeWrite, now: options.now }),
  }
}

const baseArgs = {
  name: "OPENAI_API_KEY",
  reason: "call the API",
  cwd: "/tmp/proj",
  projectPath: "/tmp/proj",
  projectTitle: "proj",
  suggestedScope: null,
}

describe("create", () => {
  test("registers a pending request the UI can render", () => {
    const { store } = createStore()
    const request = store.create(baseArgs)

    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].id).toBe(request.id)
    expect(store.resolutionFor(request.id).status).toBe("pending")
  })

  test("reuses the open prompt when the same ask is retried", () => {
    const { store } = createStore()
    const first = store.create(baseArgs)
    const second = store.create({ ...baseArgs, reason: "retried" })

    expect(second.id).toBe(first.id)
    expect(store.list()).toHaveLength(1)
  })

  test("treats the same name in a different directory as a separate ask", () => {
    const { store } = createStore()
    store.create(baseArgs)
    store.create({ ...baseArgs, cwd: "/tmp/other" })
    expect(store.list()).toHaveLength(2)
  })

  test("truncates an over-long reason", () => {
    const { store } = createStore()
    const request = store.create({ ...baseArgs, reason: "x".repeat(900) })
    expect(request.reason.length).toBe(500)
  })
})

describe("submit", () => {
  test("writes the secret and settles the request", async () => {
    const { store, written } = createStore()
    const request = store.create(baseArgs)

    const resolution = await store.submit(request.id, { scope: "project", value: "sk-live" })

    expect(resolution.status).toBe("saved")
    expect(resolution.path).toBe("/tmp/OPENAI_API_KEY.env")
    expect(resolution.gitignoreUpdated).toBe(true)
    expect(written).toEqual([
      { scope: "project", name: "OPENAI_API_KEY", value: "sk-live", projectPath: "/tmp/proj" },
    ])
  })

  test("drops the request out of the pending list once answered", async () => {
    const { store } = createStore()
    const request = store.create(baseArgs)
    await store.submit(request.id, { scope: "global", value: "v" })

    expect(store.list()).toHaveLength(0)
    expect(store.resolutionFor(request.id).status).toBe("saved")
  })

  test("never retains the value on the request itself", async () => {
    const { store } = createStore()
    const request = store.create(baseArgs)
    await store.submit(request.id, { scope: "global", value: "super-secret" })

    expect(JSON.stringify(store.get(request.id))).not.toContain("super-secret")
    expect(JSON.stringify(store.resolutionFor(request.id))).not.toContain("super-secret")
  })

  test("rejects a second answer to the same request", async () => {
    const { store } = createStore()
    const request = store.create(baseArgs)
    await store.submit(request.id, { scope: "global", value: "v" })

    await expect(store.submit(request.id, { scope: "global", value: "v2" }))
      .rejects.toThrow(/already been answered/)
  })

  test("rejects an unknown request", async () => {
    const { store } = createStore()
    await expect(store.submit("nope", { scope: "global", value: "v" }))
      .rejects.toThrow(/no longer open/)
  })

  test("rejects project scope when the ask came from outside a project", async () => {
    const { store } = createStore()
    const request = store.create({ ...baseArgs, projectPath: null, projectTitle: null })

    await expect(store.submit(request.id, { scope: "project", value: "v" }))
      .rejects.toThrow(/saved globally/)
  })
})

describe("cancel", () => {
  test("settles the request as cancelled", () => {
    const { store } = createStore()
    const request = store.create(baseArgs)

    expect(store.cancel(request.id)).toBe(true)
    expect(store.resolutionFor(request.id).status).toBe("cancelled")
    expect(store.list()).toHaveLength(0)
  })

  test("is a no-op for an unknown or already-settled request", () => {
    const { store } = createStore()
    const request = store.create(baseArgs)
    store.cancel(request.id)

    expect(store.cancel(request.id)).toBe(false)
    expect(store.cancel("nope")).toBe(false)
  })
})

describe("expiry and retention", () => {
  test("a prompt nobody answers expires", () => {
    let now = 1_000
    const { store } = createStore({ now: () => now })
    const request = store.create(baseArgs)

    now += SECRET_REQUEST_TTL_MS - 1
    expect(store.resolutionFor(request.id).status).toBe("pending")

    now += 2
    expect(store.resolutionFor(request.id).status).toBe("expired")
    expect(store.list()).toHaveLength(0)
  })

  test("a settled result stays readable long enough for the CLI to poll it", async () => {
    let now = 1_000
    const { store } = createStore({ now: () => now })
    const request = store.create(baseArgs)
    await store.submit(request.id, { scope: "global", value: "v" })

    now += SECRET_RESOLUTION_RETENTION_MS - 1
    expect(store.resolutionFor(request.id).status).toBe("saved")

    now += 2
    expect(store.resolutionFor(request.id).status).toBe("expired")
  })

  test("an unknown id reads as expired, not pending, so the CLI stops waiting", () => {
    const { store } = createStore()
    expect(store.resolutionFor("never-existed").status).toBe("expired")
  })
})

describe("onChange", () => {
  test("fires for create, submit and cancel", async () => {
    const { store } = createStore()
    let calls = 0
    const unsubscribe = store.onChange(() => {
      calls += 1
    })

    const first = store.create(baseArgs)
    await store.submit(first.id, { scope: "global", value: "v" })
    const second = store.create({ ...baseArgs, cwd: "/tmp/two" })
    store.cancel(second.id)

    expect(calls).toBe(4)
    unsubscribe()
    store.create({ ...baseArgs, cwd: "/tmp/three" })
    expect(calls).toBe(4)
  })
})
