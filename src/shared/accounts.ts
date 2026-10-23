import type { AgentProvider, AuthServiceSnapshot } from "./types"

export const ACCOUNT_PROVIDERS = ["claude", "codex", "cursor", "grok", "pi"] as const
export const existingAccountId = (provider: AgentProvider) => `existing-${provider}`

export interface AccountInput {
  provider: AgentProvider
  label: string
  /** Only Cursor and Pi accounts take keys; Claude/Codex use native login. */
  apiKey?: string
  apiProvider?: "openai" | "openrouter" | "custom"
  baseUrl?: string
}

export interface ProviderAccount {
  id: string
  provider: AgentProvider
  label: string
  mode: "existing" | "native" | "apiKey"
  identity: string | null
  authStatus: AuthServiceSnapshot["authStatus"]
  login: AuthServiceSnapshot["login"]
  statusDetail: string | null
}

export interface AccountsSnapshot {
  accounts: ProviderAccount[]
  defaultAccountIds: Partial<Record<AgentProvider, string>>
}
