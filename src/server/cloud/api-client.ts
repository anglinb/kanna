/**
 * HTTP client for the cloud control plane (the machine → control-plane half
 * of src/shared/cloud-api.ts). DI'd fetch for tests; control URL override via
 * KANNA_CLOUD_CONTROL_URL for self-hosters and the wire e2e.
 */

import process from "node:process"
import {
  CLOUD_CONTROL_URL_ENV_VAR,
  DEFAULT_CLOUD_CONTROL_URL,
  type CloudDeviceCodePollResponse,
  type CloudDeviceCodeRequest,
  type CloudDeviceCodeResponse,
  type CloudHeartbeatRequest,
  type CloudPairRequest,
  type CloudPairResponse,
} from "../../shared/cloud-api"

export class CloudApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "CloudApiError"
    this.status = status
  }
}

export interface CloudApiClientDeps {
  fetchImpl?: typeof fetch
  controlUrl?: string
}

export interface CloudApiClient {
  controlUrl: string
  pair(pairingCode: string, machineName?: string): Promise<CloudPairResponse>
  /**
   * Starts a device-code claim session: returns the URL to show (link + QR)
   * and the secret to poll with.
   */
  requestDeviceCode(machineName?: string): Promise<CloudDeviceCodeResponse>
  /**
   * Polls a claim session. Throws CloudApiError 404/410 once the session is
   * expired or already redeemed.
   */
  pollDeviceCode(deviceToken: string): Promise<CloudDeviceCodePollResponse>
  /** Liveness + the local service the connector fronts (~every 2 min). */
  heartbeat(machineToken: string, update: CloudHeartbeatRequest): Promise<void>
  /** Best-effort graceful shutdown signal — flips the machine offline immediately. */
  markOffline(machineToken: string): Promise<void>
  removeMachine(machineToken: string): Promise<void>
}

export function resolveControlUrl(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
) {
  const fromEnv = env[CLOUD_CONTROL_URL_ENV_VAR]?.trim()
  return (explicit?.trim() || fromEnv || DEFAULT_CLOUD_CONTROL_URL).replace(/\/$/, "")
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json() as { error?: unknown }
    if (typeof payload.error === "string" && payload.error) {
      return payload.error
    }
  } catch {
    // Non-JSON error body — fall through to the status line.
  }
  return `control plane returned ${response.status}`
}

export function createCloudApiClient(deps: CloudApiClientDeps = {}): CloudApiClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const controlUrl = resolveControlUrl(deps.controlUrl)

  async function request(path: string, init: RequestInit) {
    const response = await fetchImpl(`${controlUrl}${path}`, init)
    if (!response.ok) {
      throw new CloudApiError(await readErrorMessage(response), response.status)
    }
    return response
  }

  return {
    controlUrl,

    async pair(pairingCode, machineName) {
      const body: CloudPairRequest = { pairingCode, machineName }
      const response = await request("/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await response.json() as CloudPairResponse
      if (
        !payload.machineToken ||
        !payload.proxySecret ||
        !payload.subdomain ||
        !payload.appOrigin ||
        !payload.tunnelToken ||
        !payload.tunnelHost
      ) {
        throw new CloudApiError("control plane returned an incomplete pair response", 502)
      }
      return payload
    },

    async requestDeviceCode(machineName) {
      const body: CloudDeviceCodeRequest = { machineName }
      const response = await request("/device-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await response.json() as CloudDeviceCodeResponse
      if (!payload.code || !payload.deviceToken || !payload.claimUrl || !payload.expiresAt) {
        throw new CloudApiError("control plane returned an incomplete device-code response", 502)
      }
      return payload
    },

    async pollDeviceCode(deviceToken) {
      const response = await request("/device-code/poll", {
        method: "POST",
        headers: { Authorization: `Bearer ${deviceToken}` },
      })
      const payload = await response.json() as CloudDeviceCodePollResponse
      if (payload.status === "claimed" && !payload.pairing?.machineToken) {
        throw new CloudApiError("control plane claimed a device code without credentials", 502)
      }
      return payload
    },

    async heartbeat(machineToken, update) {
      await request("/heartbeat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${machineToken}`,
        },
        body: JSON.stringify(update),
      })
    },

    async markOffline(machineToken) {
      await request("/offline", {
        method: "POST",
        headers: { Authorization: `Bearer ${machineToken}` },
      })
    },

    async removeMachine(machineToken) {
      await request("/machine", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${machineToken}` },
      })
    },
  }
}
