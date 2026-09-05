import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createKannaMcpBridge } from "./kanna-mcp-bridge"
import { parseBridgeConfig } from "./kanna-mcp-stdio"

async function withBridge<T>(
  run: (bridge: ReturnType<typeof createKannaMcpBridge>, dataDir: string) => Promise<T>,
  overrides: { entryPath?: string; execPath?: string; port?: number } = {}
) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-bridge-"))
  const bridge = createKannaMcpBridge({
    dataDir,
    baseUrl: () => `http://127.0.0.1:${overrides.port ?? 3210}`,
    entryPath: overrides.entryPath ?? "/opt/kanna/src/server/cli.ts",
    execPath: overrides.execPath ?? "/usr/local/bin/bun",
  })
  try {
    return await run(bridge, dataDir)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

describe("createKannaMcpBridge", () => {
  test("mints a long random key that only matches itself", async () => {
    await withBridge(async (bridge) => {
      expect(bridge.apiKey).toMatch(/^[0-9a-f]{64}$/)
      expect(bridge.isInternalKey(bridge.apiKey)).toBe(true)
      expect(bridge.isInternalKey("nope")).toBe(false)
      expect(bridge.isInternalKey(null)).toBe(false)
      expect(bridge.isInternalKey(undefined)).toBe(false)
    })
  })

  test("two bridges never share a key", async () => {
    await withBridge(async (first) => {
      await withBridge(async (second) => {
        expect(second.apiKey).not.toBe(first.apiKey)
        expect(first.isInternalKey(second.apiKey)).toBe(false)
      })
    })
  })

  test("credentials name the chat and are readable only by the owner", async () => {
    await withBridge(async (bridge, dataDir) => {
      const filePath = await bridge.ensureCredentials("chat-1")

      expect(filePath).toBe(path.join(dataDir, "mcp", "chat-1.json"))
      const config = parseBridgeConfig(await Bun.file(filePath).text())
      expect(config).toEqual({ baseUrl: "http://127.0.0.1:3210", apiKey: bridge.apiKey, chatId: "chat-1" })
      // 0600: the key in here is a full-access credential for this instance.
      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
    })
  })

  test("rewriting credentials keeps the restricted mode", async () => {
    await withBridge(async (bridge) => {
      const filePath = await bridge.ensureCredentials("chat-1")
      await Bun.write(filePath, "clobbered")
      await bridge.ensureCredentials("chat-1")

      expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      expect(parseBridgeConfig(await Bun.file(filePath).text()).chatId).toBe("chat-1")
    })
  })

  test("release drops one chat's file and is safe to repeat", async () => {
    await withBridge(async (bridge) => {
      const kept = await bridge.ensureCredentials("keep")
      const dropped = await bridge.ensureCredentials("drop")

      await bridge.release("drop")
      await bridge.release("drop")

      expect(await Bun.file(kept).exists()).toBe(true)
      expect(await Bun.file(dropped).exists()).toBe(false)
    })
  })

  test("dispose clears the directory", async () => {
    await withBridge(async (bridge, dataDir) => {
      const filePath = await bridge.ensureCredentials("chat-1")
      await bridge.dispose()
      expect(await Bun.file(filePath).exists()).toBe(false)
      expect(await Bun.file(path.join(dataDir, "mcp")).exists()).toBe(false)
      // Idempotent, since shutdown can race a failed start.
      await bridge.dispose()
    })
  })

  test("codex overrides are TOML the CLI can parse", async () => {
    await withBridge(async (bridge) => {
      const args = bridge.codexConfigArgs("/data/mcp/chat-1.json")

      expect(args).toEqual([
        "-c",
        'mcp_servers.kanna.command="/usr/local/bin/bun"',
        "-c",
        'mcp_servers.kanna.args=["/opt/kanna/src/server/cli.ts", "mcp", "/data/mcp/chat-1.json"]',
      ])
    })
  })

  test("paths with quotes or backslashes stay valid TOML", async () => {
    await withBridge(
      async (bridge) => {
        const args = bridge.codexConfigArgs('/data/we"ird\\path.json')
        expect(args[1]).toBe('mcp_servers.kanna.command="C:\\\\Program Files\\\\bun.exe"')
        expect(args[3]).toContain('\\"ird\\\\path.json')
      },
      { execPath: "C:\\Program Files\\bun.exe" }
    )
  })

  test("the base url is read when credentials are written, not when the bridge is built", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-bridge-port-"))
    try {
      let port = 0
      const bridge = createKannaMcpBridge({ dataDir, baseUrl: () => `http://127.0.0.1:${port}` })
      port = 3999
      const filePath = await bridge.ensureCredentials("chat-1")
      expect(parseBridgeConfig(await Bun.file(filePath).text()).baseUrl).toBe("http://127.0.0.1:3999")
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
