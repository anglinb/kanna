import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CloudRuntime } from "./index"
import { Effect, FileSystem } from "effect"
import { startKannaServerEffect } from "../server"
import { BUN_ASSET_DIRS } from "../server-bun"
import { runTest } from "../effect/testing"

test("disabled server ignores supplied cloud credentials, denies every cloud route, and preserves local auth", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "kanna-cloud-off-"))
  const forbiddenRuntime = new Proxy({} as CloudRuntime, { get() { throw new Error("disabled server accessed a cloud runtime") } })
  const credentialReads: string[] = []
  const server = await runTest(Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const guarded = new Proxy(fs, { get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        if (args.some(arg => typeof arg === "string" && arg.endsWith("/cloud.json"))) {
          credentialReads.push(String(args[0]))
          throw new Error("disabled server accessed cloud credentials")
        }
        return value.apply(target, args)
      }
    } })
    return yield* startKannaServerEffect({ dataDir, port: 0, cloudEnabled: false, cloud: forbiddenRuntime, allowCloudPairing: true, password: "secret", openBrowser: false, assetDirs: BUN_ASSET_DIRS }).pipe(Effect.provideService(FileSystem.FileSystem, guarded))
  }))
  const base = `http://localhost:${server.port}`
  try {
    const capabilities = await fetch(`${base}/api/capabilities`)
    expect(await capabilities.json()).toEqual({ capabilities: { cloud: false, publicSharing: false } })
    for (const path of ["/api/cloud/fleet", "/api/cloud/ws-endpoint", "/api/cloud/pair-session", "/api/cloud/anything", "/__cloud/machines"]) {
      expect((await fetch(base + path)).status).toBe(404)
    }
    expect((await fetch(`${base}/api/cloud/pair-session`, { method: "POST" })).status).toBe(404)
    expect((await fetch(`${base}/api/diagnostics/client`, { method: "POST", headers: { "x-kanna-proxy-auth": "secret" } })).status).toBe(401)
    expect((await fetch(`${base}/ws?token=anything`, { headers: { origin: base } })).status).toBe(401)
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ password: "secret" }) })
    expect(login.status).toBe(200)
    expect((await fetch(`${base}/health`)).status).toBe(200)
    expect(server.state().cloud).toBe(false)
    expect(server.state().cloudEnabled).toBe(false)
    expect(credentialReads).toEqual([])
  } finally { await server.stop(); await rm(dataDir, { recursive: true, force: true }) }
})
