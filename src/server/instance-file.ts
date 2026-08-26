/**
 * `~/.kanna/instance.json` — how a `kanna` subcommand finds the server that
 * is already running on this machine.
 *
 * `instance.ts` answers "is something already on this port?" over /health.
 * This answers the inverse: "which port, and what credential do I present?"
 * The token is minted per server start and the file is 0600, so it is a
 * same-user capability and nothing more. It is not a substitute for the
 * password gate — the endpoints it unlocks are loopback-only by construction.
 */

import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getInstanceFilePath } from "../shared/branding"

const FILE_MODE = 0o600

export interface InstanceFile {
  port: number
  url: string
  token: string
  pid: number
  /** Fingerprint of the data dir being served (see instance.ts). */
  instance: string
  startedAt: number
}

export function mintInstanceToken(): string {
  return randomBytes(32).toString("hex")
}

export async function writeInstanceFile(
  contents: InstanceFile,
  filePath: string = getInstanceFilePath(homedir()),
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, {
    encoding: "utf8",
    mode: FILE_MODE,
  })
  await chmod(filePath, FILE_MODE)
}

/** Returns null for anything unreadable or malformed — callers fall back to a clear error. */
export async function readInstanceFile(
  filePath: string = getInstanceFilePath(homedir()),
): Promise<InstanceFile | null> {
  let raw: string
  try {
    raw = await readFile(filePath, "utf8")
  } catch {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<InstanceFile>
    if (
      typeof parsed.port !== "number"
      || typeof parsed.url !== "string"
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) {
      return null
    }
    return {
      port: parsed.port,
      url: parsed.url,
      token: parsed.token,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      instance: typeof parsed.instance === "string" ? parsed.instance : "",
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
    }
  } catch {
    return null
  }
}

/** Best-effort: a stale file is harmless, since the token stops matching. */
export async function removeInstanceFile(
  filePath: string = getInstanceFilePath(homedir()),
): Promise<void> {
  try {
    await rm(filePath, { force: true })
  } catch {
    // ignore
  }
}
