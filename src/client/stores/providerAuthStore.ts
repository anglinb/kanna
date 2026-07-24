import { useMemo } from "react"
import { create } from "zustand"
import {
  authServiceForProvider,
  type AgentProvider,
  type AuthServiceId,
  type AuthServiceSnapshot,
  type ProviderAuthSnapshot,
} from "../../shared/types"
import type { KannaSocket } from "../app/socket"
import {
  SETUP_WIZARD_COMPLETED_STORAGE_KEY,
  SETUP_WIZARD_DISMISSED_STORAGE_KEY,
} from "../lib/storageKeys"

function readStorageFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function writeStorageFlag(key: string) {
  try {
    window.localStorage.setItem(key, String(Date.now()))
  } catch {
    // Private mode etc. — the in-memory flag still applies for this session.
  }
}

interface ProviderAuthStore {
  snapshot: ProviderAuthSnapshot | null
  /** The app socket, registered by the layout so deep components can send auth commands. */
  socket: KannaSocket | null
  /** Full-screen setup wizard visibility. */
  setupWizardOpen: boolean
  /** The wizard's final step was completed (persisted). Hides the Setup cards. */
  setupCompleted: boolean
  /** "Set up later" was chosen (persisted). Suppresses auto-launch only. */
  setupDismissed: boolean
  setSnapshot: (snapshot: ProviderAuthSnapshot | null) => void
  setSocket: (socket: KannaSocket | null) => void
  openSetupWizard: () => void
  /** Close without finishing — persists the dismissal so we never auto-launch again. */
  dismissSetupWizard: () => void
  /** Close from the final step — persists completion so Setup cards disappear. */
  completeSetupWizard: () => void
}

export const useProviderAuthStore = create<ProviderAuthStore>((set) => ({
  snapshot: null,
  socket: null,
  setupWizardOpen: false,
  setupCompleted: readStorageFlag(SETUP_WIZARD_COMPLETED_STORAGE_KEY),
  setupDismissed: readStorageFlag(SETUP_WIZARD_DISMISSED_STORAGE_KEY),
  setSnapshot: (snapshot) => set({ snapshot }),
  setSocket: (socket) => set({ socket }),
  openSetupWizard: () => set({ setupWizardOpen: true }),
  dismissSetupWizard: () => {
    writeStorageFlag(SETUP_WIZARD_DISMISSED_STORAGE_KEY)
    set({ setupWizardOpen: false, setupDismissed: true })
  },
  completeSetupWizard: () => {
    writeStorageFlag(SETUP_WIZARD_COMPLETED_STORAGE_KEY)
    set({ setupWizardOpen: false, setupCompleted: true, setupDismissed: true })
  },
}))

export function selectAuthService(
  snapshot: ProviderAuthSnapshot | null,
  service: AuthServiceId
): AuthServiceSnapshot | null {
  return snapshot?.services.find((entry) => entry.service === service) ?? null
}

/**
 * Harnesses whose gating auth service is known to be signed out or missing.
 * "unknown"/"error" states don't gate — never block a switch on a failed probe.
 */
export function getUnauthenticatedHarnesses(snapshot: ProviderAuthSnapshot | null): Set<AgentProvider> {
  const result = new Set<AgentProvider>()
  if (!snapshot) return result
  for (const provider of ["claude", "codex", "cursor"] as const) {
    const serviceId = authServiceForProvider(provider)
    if (!serviceId) continue
    const service = selectAuthService(snapshot, serviceId)
    if (service && (service.authStatus === "signed_out" || service.authStatus === "not_installed")) {
      result.add(provider)
    }
  }
  return result
}

export function useAuthService(service: AuthServiceId): AuthServiceSnapshot | null {
  return useProviderAuthStore((store) => selectAuthService(store.snapshot, service))
}

export function useUnauthenticatedHarnesses(): Set<AgentProvider> {
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  return useMemo(() => getUnauthenticatedHarnesses(snapshot), [snapshot])
}

export interface SetupStatus {
  /** Every service the flow cares about has been probed (no "unknown" left). */
  resolved: boolean
  githubConnected: boolean
  /** At least one coding-agent harness (claude/codex/cursor) is signed in. */
  anyAgentConnected: boolean
  openRouterConnected: boolean
  /** Something the wizard covers is still unconnected. */
  missingAny: boolean
}

export function getSetupStatus(snapshot: ProviderAuthSnapshot | null): SetupStatus {
  const services = snapshot?.services ?? []
  const byId = new Map(services.map((service) => [service.service, service]))
  const isConnected = (id: AuthServiceId) => byId.get(id)?.authStatus === "signed_in"
  const relevant: AuthServiceId[] = ["claude", "codex", "cursor", "gh", "openrouter"]
  const resolved = services.length > 0 && relevant.every((id) => {
    const status = byId.get(id)?.authStatus
    return status !== undefined && status !== "unknown"
  })
  const githubConnected = isConnected("gh")
  const anyAgentConnected = isConnected("claude") || isConnected("codex") || isConnected("cursor")
  const openRouterConnected = isConnected("openrouter")
  return {
    resolved,
    githubConnected,
    anyAgentConnected,
    openRouterConnected,
    missingAny: !githubConnected || !anyAgentConnected || !openRouterConnected,
  }
}

export function useSetupStatus(): SetupStatus {
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  return useMemo(() => getSetupStatus(snapshot), [snapshot])
}

/** The Setup card (home + new-chat) shows until the wizard has been finished. */
export function useShowSetupCard(): boolean {
  const status = useSetupStatus()
  const setupCompleted = useProviderAuthStore((store) => store.setupCompleted)
  return status.resolved && status.missingAny && !setupCompleted
}
