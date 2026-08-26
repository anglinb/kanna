import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { SECRETS_API_PATH_PREFIX, SECRETS_API_TOKEN_HEADER } from "../shared/secrets"
import { SecretRequestStore } from "./secret-requests"
import { createSecretsApi, resolveAskingChat, resolveProjectFromCwd } from "./secrets-api"
import { writeSecret } from "./secrets"

const TOKEN = "test-token-0123456789"

let project: string
let requests: SecretRequestStore
let handle: ReturnType<typeof createSecretsApi>

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "kanna-secrets-api-"))
  requests = new SecretRequestStore()
  handle = createSecretsApi({
    requests,
    token: TOKEN,
    resolveProject: (cwd) => resolveProjectFromCwd(cwd, [{ path: project, title: "proj" }]),
  })
})

afterEach(async () => {
  requests.dispose()
  await rm(project, { recursive: true, force: true })
})

function call(pathname: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = TOKEN, ...rest } = init
  const url = new URL(`http://127.0.0.1:3000${pathname}`)
  const headers = new Headers(rest.headers)
  headers.set("content-type", "application/json")
  if (token !== null) headers.set(SECRETS_API_TOKEN_HEADER, token)
  return handle(new Request(url, { ...rest, headers }), url)
}

describe("routing and auth", () => {
  test("ignores paths that are not ours so the caller can keep routing", async () => {
    expect(await call("/api/projects")).toBeNull()
    expect(await call("/")).toBeNull()
  })

  test("rejects a missing or wrong token", async () => {
    const missing = await call(`${SECRETS_API_PATH_PREFIX}/list`, { token: null })
    expect(missing?.status).toBe(401)

    const wrong = await call(`${SECRETS_API_PATH_PREFIX}/list`, { token: "nope" })
    expect(wrong?.status).toBe(401)
  })

  test("a token of the right length but wrong value still fails", async () => {
    const response = await call(`${SECRETS_API_PATH_PREFIX}/list`, {
      token: "x".repeat(TOKEN.length),
    })
    expect(response?.status).toBe(401)
  })

  test("404s an unknown subpath under the prefix", async () => {
    const response = await call(`${SECRETS_API_PATH_PREFIX}/nonsense`)
    expect(response?.status).toBe(404)
  })
})

describe("POST /requests", () => {
  test("queues a prompt and returns its id", async () => {
    const response = await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "OPENAI_API_KEY", reason: "call the API", cwd: project }),
    })

    const body = await response!.json()
    expect(body.status).toBe("pending")
    expect(typeof body.requestId).toBe("string")

    const pending = requests.list()
    expect(pending).toHaveLength(1)
    expect(pending[0].name).toBe("OPENAI_API_KEY")
    expect(pending[0].projectPath).toBe(project)
    expect(pending[0].projectTitle).toBe("proj")
  })

  test("resolves the project from a subdirectory", async () => {
    await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: path.join(project, "src", "deep") }),
    })
    expect(requests.list()[0].projectPath).toBe(project)
  })

  test("records no project when the cwd is outside every known one", async () => {
    await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: tmpdir() }),
    })
    expect(requests.list()[0].projectPath).toBeNull()
  })

  test("short-circuits when the secret is already stored", async () => {
    const written = await writeSecret({
      scope: "project",
      name: "TOKEN",
      value: "already-here",
      projectPath: project,
    })

    const response = await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: project }),
    })

    const body = await response!.json()
    expect(body.status).toBe("saved")
    expect(body.existing).toBe(true)
    expect(body.scope).toBe("project")
    expect(body.path).toBe(written.path)
    expect(body.loadCommand).toContain("set -a")
    expect(JSON.stringify(body)).not.toContain("already-here")
    expect(requests.list()).toHaveLength(0)
  })

  test("--force re-prompts even when one is stored", async () => {
    await writeSecret({ scope: "project", name: "TOKEN", value: "old", projectPath: project })

    const response = await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: project, force: true }),
    })

    expect((await response!.json()).status).toBe("pending")
    expect(requests.list()).toHaveLength(1)
  })

  test("carries the agent's suggested scope through to the prompt", async () => {
    await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: project, scope: "global" }),
    })
    expect(requests.list()[0].suggestedScope).toBe("global")
  })

  test("rejects a name that is not shell-legal", async () => {
    for (const name of ["../etc/passwd", "MY-KEY", "2FA", ""]) {
      const response = await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
        method: "POST",
        body: JSON.stringify({ name, cwd: project }),
      })
      expect(response?.status).toBe(400)
    }
    expect(requests.list()).toHaveLength(0)
  })

  test("rejects a non-JSON body", async () => {
    const response = await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: "not json",
    })
    expect(response?.status).toBe(400)
  })
})

describe("GET and DELETE /requests/:id", () => {
  test("reports pending, then the settled result", async () => {
    const created = await (await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: project }),
    }))!.json()

    const whilePending = await (await call(
      `${SECRETS_API_PATH_PREFIX}/requests/${created.requestId}`,
    ))!.json()
    expect(whilePending.status).toBe("pending")

    await requests.submit(created.requestId, { scope: "project", value: "sk-value" })

    const settled = await (await call(
      `${SECRETS_API_PATH_PREFIX}/requests/${created.requestId}`,
    ))!.json()
    expect(settled.status).toBe("saved")
    expect(settled.loadCommand).toContain("TOKEN.env")
    expect(JSON.stringify(settled)).not.toContain("sk-value")
  })

  test("DELETE cancels the prompt", async () => {
    const created = await (await call(`${SECRETS_API_PATH_PREFIX}/requests`, {
      method: "POST",
      body: JSON.stringify({ name: "TOKEN", cwd: project }),
    }))!.json()

    const response = await call(`${SECRETS_API_PATH_PREFIX}/requests/${created.requestId}`, {
      method: "DELETE",
    })
    expect(response?.status).toBe(200)
    expect(requests.resolutionFor(created.requestId).status).toBe("cancelled")
  })

  test("405s an unsupported method", async () => {
    const response = await call(`${SECRETS_API_PATH_PREFIX}/requests/abc`, { method: "PUT" })
    expect(response?.status).toBe(405)
  })
})

describe("GET /list", () => {
  test("returns names and scopes but no values", async () => {
    await writeSecret({ scope: "project", name: "TOKEN", value: "hunter2", projectPath: project })

    const body = await (await call(
      `${SECRETS_API_PATH_PREFIX}/list?cwd=${encodeURIComponent(project)}`,
    ))!.json()

    expect(body.secrets).toContainEqual({ scope: "project", name: "TOKEN" })
    expect(JSON.stringify(body)).not.toContain("hunter2")
  })
})

describe("resolveProjectFromCwd", () => {
  const projects = [
    { path: "/repos/outer", title: "outer" },
    { path: "/repos/outer/nested", title: "nested" },
    { path: "/repos/other", title: "other" },
  ]

  test("matches the project root itself", () => {
    expect(resolveProjectFromCwd("/repos/other", projects)?.title).toBe("other")
  })

  test("matches from a subdirectory", () => {
    expect(resolveProjectFromCwd("/repos/other/src/lib", projects)?.title).toBe("other")
  })

  test("prefers the deepest match when projects nest", () => {
    expect(resolveProjectFromCwd("/repos/outer/nested/src", projects)?.title).toBe("nested")
    expect(resolveProjectFromCwd("/repos/outer/src", projects)?.title).toBe("outer")
  })

  test("does not match a sibling with a shared prefix", () => {
    expect(resolveProjectFromCwd("/repos/outer-other", projects)).toBeNull()
  })

  test("returns null when nothing contains the cwd", () => {
    expect(resolveProjectFromCwd("/elsewhere", projects)).toBeNull()
  })
})

describe("resolveAskingChat", () => {
  const roots: Record<string, string> = {
    "chat-outer": "/repos/outer",
    "chat-nested": "/repos/outer/nested",
    "chat-other": "/repos/other",
  }
  const chatLocalPath = (chatId: string) => roots[chatId] ?? null

  test("a claimed chat id wins outright", () => {
    expect(resolveAskingChat({
      cwd: "/somewhere/unrelated",
      claimedChatId: "chat-from-env",
      runningChatIds: [],
      chatLocalPath,
    })).toBe("chat-from-env")
  })

  test("falls back to the running chat whose project contains the cwd", () => {
    expect(resolveAskingChat({
      cwd: "/repos/other/src",
      claimedChatId: null,
      runningChatIds: ["chat-outer", "chat-other"],
      chatLocalPath,
    })).toBe("chat-other")
  })

  test("prefers the deepest root when projects nest", () => {
    expect(resolveAskingChat({
      cwd: "/repos/outer/nested/src",
      claimedChatId: null,
      runningChatIds: ["chat-outer", "chat-nested"],
      chatLocalPath,
    })).toBe("chat-nested")
  })

  test("ignores chats that are not running", () => {
    expect(resolveAskingChat({
      cwd: "/repos/other/src",
      claimedChatId: null,
      runningChatIds: ["chat-outer"],
      chatLocalPath,
    })).toBeNull()
  })

  test("gives up rather than guess between two chats in the same project", () => {
    expect(resolveAskingChat({
      cwd: "/repos/outer/src",
      claimedChatId: null,
      runningChatIds: ["chat-outer", "chat-outer-twin"],
      chatLocalPath: (chatId) => (
        chatId === "chat-outer-twin" ? "/repos/outer" : chatLocalPath(chatId)
      ),
    })).toBeNull()
  })

  test("does not match a sibling with a shared prefix", () => {
    expect(resolveAskingChat({
      cwd: "/repos/outer-other/src",
      claimedChatId: null,
      runningChatIds: ["chat-outer"],
      chatLocalPath,
    })).toBeNull()
  })
})
