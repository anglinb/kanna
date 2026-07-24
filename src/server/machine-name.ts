import { readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import process from "node:process"
import { spawnSync } from "node:child_process"
import { getCloudFilePath } from "../shared/branding"

function runAndRead(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (result.status !== 0) return null
  const value = result.stdout.trim()
  return value || null
}

/**
 * Dev-boxes (direct-mode cloud identities) are named by the subdomain the
 * user picked at creation — the sandbox's own hostname is a random id.
 */
export function readDevboxSubdomain(identityPath = getCloudFilePath(homedir())): string | null {
  try {
    const parsed = JSON.parse(readFileSync(identityPath, "utf8")) as {
      mode?: unknown
      subdomain?: unknown
    }
    if (parsed?.mode !== "direct") return null
    const subdomain = typeof parsed.subdomain === "string" ? parsed.subdomain.trim() : ""
    return subdomain || null
  } catch {
    return null
  }
}

export function getMachineDisplayName(identityPath?: string) {
  const devboxSubdomain = readDevboxSubdomain(identityPath)
  if (devboxSubdomain) {
    return devboxSubdomain
  }

  if (process.platform === "darwin") {
    const computerName = runAndRead("scutil", ["--get", "ComputerName"])
    if (computerName) {
      return computerName
    }
  }

  const rawHostname = hostname().trim()
  return rawHostname.replace(/\.local$|\.lan$/i, "") || "This Machine"
}
