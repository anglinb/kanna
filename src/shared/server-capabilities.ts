/** Runtime features, independent of pairing credentials and connection state. */
export interface ServerCapabilities {
  cloud: boolean
  publicSharing: boolean
}
export const SERVER_CAPABILITIES_PATH = "/api/capabilities"
export const capabilitiesForCloud = (enabled: boolean): ServerCapabilities => ({ cloud: enabled, publicSharing: enabled })
export const DEFAULT_SERVER_CAPABILITIES = capabilitiesForCloud(true)
export const DISABLED_SERVER_CAPABILITIES = capabilitiesForCloud(false)
export const CLOUD_ENABLED_ENV_VAR = "KANNA_CLOUD_ENABLED"

/** CLI > environment > config > enabled by default. Invalid settings fail explicitly. */
export function resolveCloudEnabled(configText?: string, environmentValue?: string, cliOverride?: boolean): boolean {
  if (cliOverride !== undefined) return cliOverride
  if (environmentValue?.trim()) {
    const value = environmentValue.trim().toLowerCase()
    if (value === "true" || value === "1") return true
    if (value === "false" || value === "0") return false
    throw new Error(`${CLOUD_ENABLED_ENV_VAR} must be true, false, 1, or 0.`)
  }
  if (configText === undefined) return true
  const config: unknown = JSON.parse(configText)
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config.json must contain an object.")
  const cloud = (config as { cloud?: unknown }).cloud
  if (cloud === undefined) return true
  if (!cloud || typeof cloud !== "object" || Array.isArray(cloud)) throw new Error("cloud must be an object.")
  const enabled = (cloud as { enabled?: unknown }).enabled
  if (enabled === undefined) return true
  if (typeof enabled !== "boolean") throw new Error("cloud.enabled must be a boolean.")
  return enabled
}
