/**
 * Plumbing that lets a Codex session reach the Kanna management tools.
 *
 * Claude gets them in-process (kanna-mcp-claude.ts). Codex has no such hook,
 * so each session spawns `kanna mcp <credentials>` as a stdio MCP server and
 * that child calls back into `/api/v1` on loopback. This module owns the three
 * things that makes necessary: the internal API key, the per-chat credentials
 * file, and the `-c` overrides that point `codex app-server` at the child.
 *
 * The key is minted per run and never written to the user's config. It is
 * accepted only on loopback requests (see server.ts), so a paired machine's
 * tunnel cannot reach the API with it even though the API is now always
 * mounted for local callers.
 *
 * Credentials go in a 0600 file rather than argv or the environment: `ps`
 * shows a child's command line to every user on the machine, and codex passes
 * its own environment through to the MCP servers it spawns.
 */

import path from "node:path"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import { serializeBridgeConfig } from "./kanna-mcp-stdio"

/** Server name codex will prefix onto the tool names it reports. */
export const KANNA_MCP_SERVER_NAME = "kanna"

export interface KannaMcpBridge {
  readonly apiKey: string
  /** True for a key that is this run's internal one. */
  isInternalKey: (candidate: string | null | undefined) => boolean
  /** Write (or refresh) the credentials for one chat; returns the file path. */
  ensureCredentials: (chatId: string) => Promise<string>
  /** Drop a chat's credentials once its session is gone. */
  release: (chatId: string) => Promise<void>
  /** Remove the whole credentials directory (shutdown). */
  dispose: () => Promise<void>
  /** `-c key=value` overrides pointing `codex app-server` at the bridge. */
  codexConfigArgs: (credentialsPath: string) => string[]
}

/** TOML basic string, for a `-c key=value` whose value is parsed as TOML. */
function tomlString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function tomlStringArray(values: string[]) {
  return `[${values.map(tomlString).join(", ")}]`
}

export function createKannaMcpBridge(args: {
  dataDir: string
  /** Read late: the port is only known once Bun.serve has picked one. */
  baseUrl: () => string
  /** Absolute path to the `kanna mcp` entry point. Injectable for tests. */
  entryPath?: string
  /** Executable that runs it. Defaults to the Bun running this process. */
  execPath?: string
}): KannaMcpBridge {
  const apiKey = randomBytes(32).toString("hex")
  const directory = path.join(args.dataDir, "mcp")
  // src/server/cli.ts sits next to this file in both the repo and the
  // published package (`files` ships all of src/server/).
  const entryPath = args.entryPath ?? path.join(import.meta.dir, "cli.ts")
  const execPath = args.execPath ?? process.execPath

  const credentialsPath = (chatId: string) => path.join(directory, `${chatId}.json`)

  return {
    apiKey,
    isInternalKey: (candidate) => typeof candidate === "string" && candidate === apiKey,

    async ensureCredentials(chatId: string) {
      const filePath = credentialsPath(chatId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(
        filePath,
        serializeBridgeConfig({ baseUrl: args.baseUrl(), apiKey, chatId }),
        { mode: 0o600 }
      )
      // Explicit chmod as well as the open mode: writeFile's mode only applies
      // when it creates the file, and this rewrites an existing one whenever a
      // session restarts on a new port.
      await chmod(filePath, 0o600)
      return filePath
    },

    async release(chatId: string) {
      await rm(credentialsPath(chatId), { force: true })
    },

    async dispose() {
      await rm(directory, { recursive: true, force: true })
    },

    codexConfigArgs(path: string) {
      const prefix = `mcp_servers.${KANNA_MCP_SERVER_NAME}`
      return [
        "-c",
        `${prefix}.command=${tomlString(execPath)}`,
        "-c",
        `${prefix}.args=${tomlStringArray([entryPath, "mcp", path])}`,
      ]
    },
  }
}
