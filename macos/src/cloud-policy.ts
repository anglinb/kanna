import fs from "node:fs"
import path from "node:path"
import { CLOUD_ENABLED_ENV_VAR, resolveCloudEnabled } from "../../src/shared/server-capabilities"

/** The wrapper shares the CLI's policy; credential files are never consulted here. */
export function desktopCloudEnabled(root: string | null, env: Record<string, string | undefined>): boolean {
  try {
    const environmentValue = env[CLOUD_ENABLED_ENV_VAR]
    let text: string | undefined
    if (root && !environmentValue?.trim()) {
      try { text = fs.readFileSync(path.join(root, "config.json"), "utf8") }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return false }
    }
    return resolveCloudEnabled(text, environmentValue)
  } catch {
    return false
  }
}

/** Older servers cannot attest that every cloud feature is disabled. */
export async function serverCloudPolicyMatches(url: string, desired: boolean, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(new URL("/api/capabilities", url), { signal: AbortSignal.timeout(5_000) })
    if (response.status === 404) return desired
    if (!response.ok) return false
    if (!response.headers.get("content-type")?.includes("application/json")) return desired
    const body = await response.json() as { capabilities?: { cloud?: unknown } }
    const enabled = body.capabilities?.cloud
    return typeof enabled === "boolean" ? enabled === desired : desired
  } catch { return false }
}
