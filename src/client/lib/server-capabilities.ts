import { DEFAULT_SERVER_CAPABILITIES, DISABLED_SERVER_CAPABILITIES, SERVER_CAPABILITIES_PATH, type ServerCapabilities } from "../../shared/server-capabilities"

/** Older servers have no manifest; network failures fail closed until the next page load. */
export async function fetchServerCapabilities(fetchImpl: typeof fetch = fetch): Promise<ServerCapabilities> {
  try {
    const response = await fetchImpl(SERVER_CAPABILITIES_PATH, { headers: { Accept: "application/json" }, cache: "no-store" })
    if (response.status === 404) return { ...DEFAULT_SERVER_CAPABILITIES }
    if (!response.ok) return { ...DISABLED_SERVER_CAPABILITIES }
    if (!response.headers.get("content-type")?.includes("application/json")) return { ...DEFAULT_SERVER_CAPABILITIES }
    const payload = await response.json()
    if (typeof payload?.capabilities?.cloud !== "boolean") return { ...DEFAULT_SERVER_CAPABILITIES }
    return {
      cloud: payload.capabilities.cloud,
      publicSharing: payload.capabilities.cloud && payload.capabilities.publicSharing === true,
    }
  } catch {
    return { ...DISABLED_SERVER_CAPABILITIES }
  }
}
