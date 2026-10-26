/** Grok's headless adapter does not expose a way to register MCP servers. */
export const MCP_PROVIDERS = ["claude", "codex", "cursor", "pi"] as const
export type McpProvider = (typeof MCP_PROVIDERS)[number]

/** Avoid native config merges combining a stdio command with a bridge URL. */
export const mcpBridgeName = (name: string) => `kanna-${name}`

export interface McpServerInput {
  id?: string
  name: string
  transport: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  providers: McpProvider[]
  projectPath?: string
  clientId?: string
  clientSecret?: string
}
export type ManagedMcpServer = McpServerInput & { id: string }

/** Credentials never travel in a settings snapshot. Omitted secrets are retained on edit. */
export type McpServerSummary = Omit<ManagedMcpServer, "args" | "env" | "headers" | "clientSecret"> & {
  argumentCount: number
  environmentKeys: string[]
  headerKeys: string[]
  hasClientSecret: boolean
  status: "unconnected" | "connected" | "needsAuth" | "error"
  toolCount?: number
  message?: string
}

export interface McpSnapshot {
  servers: McpServerSummary[]
  filePath: string
  revision: number
}

/** Only local, short-lived bridge credentials are handed to harnesses. */
export interface McpBridgeEndpoint {
  url: string
  headers: { Authorization: string }
}
export type McpBridgeServers = Record<string, McpBridgeEndpoint>

export interface McpConnectResult {
  status: McpServerSummary["status"]
  authorizationUrl?: string
}
