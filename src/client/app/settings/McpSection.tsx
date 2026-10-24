import { useCallback, useEffect, useState } from "react"
import { ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react"
import { MCP_PROVIDERS, type McpConnectResult, type McpProvider, type McpServerInput, type McpServerSummary, type McpSnapshot } from "../../../shared/mcp"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { Textarea } from "../../components/ui/textarea"
import { Switch } from "../../components/ui/switch"
import { SelectItem } from "../../components/ui/select"
import type { KannaState } from "../useKannaState"
import { SettingsActionButton, SettingsBadge, SettingsGroup, SettingsGroups, SettingsNotice, SettingsPlaceholder, SettingsRow, SettingsSelect } from "./shared"

const LABELS: Record<McpProvider, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor", pi: "Pi" }
const STATUS = { unconnected: "Not tested", connected: "Connected", needsAuth: "Sign-in required", error: "Connection failed" }
const empty = (): McpServerInput => ({ name: "", transport: "http", url: "", providers: [...MCP_PROVIDERS] })
const inputOf = (server: McpServerSummary): McpServerInput => ({
  id: server.id, name: server.name, transport: server.transport, command: server.command,
  url: server.url, providers: [...server.providers], projectPath: server.projectPath, clientId: server.clientId,
})

export function McpSection({ state }: { state: Pick<KannaState, "socket"> }) {
  const { socket } = state
  const [snapshot, setSnapshot] = useState<McpSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<McpServerInput | null>(null)
  const [advanced, setAdvanced] = useState("{}")
  const [importing, setImporting] = useState(false)
  const [importContent, setImportContent] = useState("")
  const [authorization, setAuthorization] = useState<Record<string, string>>({})
  const load = useCallback(async () => {
    const next = await socket.command<McpSnapshot>({ type: "mcp.read" })
    setSnapshot(next)
    setAuthorization((current) => Object.fromEntries(Object.entries(current).filter(([id]) => next.servers.some((server) => server.id === id && server.status === "needsAuth"))))
  }, [socket])
  useEffect(() => {
    let mounted = true
    socket.command<McpSnapshot>({ type: "mcp.read" }).then((next) => { if (mounted) setSnapshot(next) }).catch(() => { if (mounted) setError("Unable to load MCP servers.") })
    return () => { mounted = false }
  }, [socket])
  const waitingForSignIn = Object.keys(authorization).length > 0
  useEffect(() => {
    if (!waitingForSignIn) return
    const timer = window.setInterval(() => { void load().catch(() => {}) }, 2000)
    return () => window.clearInterval(timer)
  }, [waitingForSignIn, load])

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(null)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update MCP servers.") }
    finally { setBusy(false) }
  }
  function edit(server?: McpServerSummary) {
    setError(null); setImporting(false)
    setDraft(server ? inputOf(server) : empty())
    setAdvanced("{}")
  }
  async function saveDraft() {
    if (!draft) return
    await perform(async () => {
      let extra: Record<string, unknown>
      try {
        extra = JSON.parse(advanced)
        if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new Error()
      } catch { throw new Error("Advanced settings must be a JSON object.") }
      const allowed = ["args", "env", "headers", "clientId", "clientSecret"]
      if (Object.keys(extra).some((key) => !allowed.includes(key))) throw new Error(`Advanced settings accept: ${allowed.join(", ")}.`)
      setSnapshot(await socket.command<McpSnapshot>({ type: "mcp.save", server: { ...draft, ...extra } }))
      setDraft(null)
    })
  }
  return (
    <div className="flex flex-col gap-6">
      {error ? <SettingsNotice>{error}</SettingsNotice> : null}
      <div className="flex flex-wrap items-center gap-4 px-4">
        <SettingsActionButton disabled={busy} icon={<Plus />} onClick={() => edit()}>Add server</SettingsActionButton>
        <SettingsActionButton disabled={busy} onClick={() => { setDraft(null); setImporting(!importing) }}>Import configuration</SettingsActionButton>
        <SettingsActionButton disabled={busy} icon={<RefreshCw />} onClick={() => void perform(load)}>Refresh</SettingsActionButton>
      </div>
      {draft ? (
        <form onSubmit={(event) => { event.preventDefault(); void saveDraft() }}>
          <SettingsGroup title={draft.id ? "Edit server" : "New server"}>
            <SettingsRow title="Name" wideControl><Input aria-label="Server name" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="github" /></SettingsRow>
            <SettingsRow title="Connection">
              <SettingsSelect aria-label="Connection type" value={draft.transport} onValueChange={(transport) => setDraft({ ...draft, transport: transport as McpServerInput["transport"] })}>
                <SelectItem value="http">Remote HTTP</SelectItem><SelectItem value="sse">Remote SSE</SelectItem><SelectItem value="stdio">Local command</SelectItem>
              </SettingsSelect>
            </SettingsRow>
            {draft.transport === "stdio" ? <SettingsRow title="Command" wideControl><Input aria-label="Server command" required value={draft.command ?? ""} placeholder="npx" onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></SettingsRow>
              : <SettingsRow title="Server URL" wideControl><Input aria-label="Server URL" type="url" required value={draft.url ?? ""} placeholder="https://example.com/mcp" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></SettingsRow>}
            <SettingsRow title="Project folder" description="Leave empty to use this server in every project." wideControl><Input aria-label="Project folder" value={draft.projectPath ?? ""} placeholder="All projects" onChange={(event) => setDraft({ ...draft, projectPath: event.target.value || undefined })} /></SettingsRow>
            <div className="flex flex-col gap-3 px-4 py-3">
              <label htmlFor="mcp-advanced" className="text-sm font-medium">Arguments and authentication</label>
              <Textarea id="mcp-advanced" rows={5} spellCheck={false} value={advanced} onChange={(event) => setAdvanced(event.target.value)} placeholder={'{"args": ["-y", "my-mcp-server"], "env": {"API_KEY": "…"}}'} />
              <p className="text-xs text-muted-foreground">Optional JSON: args, env, headers, clientId, clientSecret. Existing arguments and credentials are retained unless you replace them or change the connection target. Sign in to OAuth servers after saving.</p>
              <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>Save server</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button></div>
            </div>
          </SettingsGroup>
        </form>
      ) : null}
      {importing ? (
        <SettingsGroup title="Import into Kanna">
          <div className="flex flex-col gap-3 px-4 py-4">
            <p className="text-sm text-muted-foreground">Import server definitions, then sign in once in Kanna. Original provider files stay unchanged; existing provider OAuth logins cannot be transferred.</p>
            <div className="flex flex-wrap gap-2">{(["claude", "codex", "cursor"] as const).map((provider) => <Button key={provider} variant="secondary" size="sm" disabled={busy} onClick={() => void perform(async () => { setSnapshot(await socket.command<McpSnapshot>({ type: "mcp.importProvider", provider })); setImporting(false) })}>Import from {LABELS[provider]}</Button>)}</div>
            <label htmlFor="mcp-import" className="text-sm font-medium">Or paste JSON / TOML configuration</label>
            <Textarea id="mcp-import" rows={7} spellCheck={false} value={importContent} onChange={(event) => setImportContent(event.target.value)} placeholder={'{"mcpServers": {"example": {"url": "https://example.com/mcp"}}}'} />
            <div className="flex gap-2"><Button size="sm" disabled={busy || !importContent.trim()} onClick={() => void perform(async () => { setSnapshot(await socket.command<McpSnapshot>({ type: "mcp.importConfig", content: importContent, providers: [...MCP_PROVIDERS] })); setImporting(false); setImportContent("") })}>Import servers</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => setImporting(false)}>Cancel</Button></div>
          </div>
        </SettingsGroup>
      ) : null}
      {!snapshot ? <SettingsPlaceholder loading>Loading MCP servers…</SettingsPlaceholder> : snapshot.servers.length === 0 ? <SettingsPlaceholder>Add a remote server URL or a local command. Sign in once and use its tools across providers.</SettingsPlaceholder> : (
        <SettingsGroups>{snapshot.servers.map((server) => (
          <SettingsGroup key={server.id} title={server.name} trailing={<SettingsBadge>{STATUS[server.status]}{server.toolCount === undefined ? "" : ` · ${server.toolCount} tools`}</SettingsBadge>}>
            <SettingsRow title={server.transport === "stdio" ? "Local command" : "Remote server"} description={<span className="break-all">{server.transport === "stdio" ? server.command : server.url}<br />{server.message ?? (server.projectPath ? `Project: ${server.projectPath}` : "All projects")}</span>} wideControl>
              <div className="flex flex-wrap items-center gap-3">
                {authorization[server.id] ? <a className="inline-flex items-center gap-1 text-sm underline underline-offset-2" href={authorization[server.id]} target="_blank" rel="noopener noreferrer">Continue sign-in<ExternalLink className="size-3" /></a>
                  : <SettingsActionButton disabled={busy} onClick={() => void perform(async () => { const result = await socket.command<McpConnectResult>({ type: "mcp.connect", id: server.id }); if (result.authorizationUrl) setAuthorization((value) => ({ ...value, [server.id]: result.authorizationUrl! })); await load() })}>{server.status === "needsAuth" ? "Sign in" : "Test connection"}</SettingsActionButton>}
                <SettingsActionButton disabled={busy} onClick={() => edit(server)}>Edit</SettingsActionButton>
                <Button variant="ghost" size="icon" aria-label={`Remove ${server.name}`} disabled={busy} onClick={() => void perform(async () => { setSnapshot(await socket.command<McpSnapshot>({ type: "mcp.remove", id: server.id })) })}><Trash2 data-icon="inline-start" /></Button>
              </div>
            </SettingsRow>
            {MCP_PROVIDERS.map((provider) => <SettingsRow key={provider} title={LABELS[provider]} description={`Use ${server.name} in ${LABELS[provider]} chats.`}><Switch aria-label={`Use ${server.name} in ${LABELS[provider]}`} disabled={busy} checked={server.providers.includes(provider)} onCheckedChange={(enabled) => void perform(async () => { const providers = enabled ? [...server.providers, provider] : server.providers.filter((value) => value !== provider); setSnapshot(await socket.command<McpSnapshot>({ type: "mcp.save", server: { ...inputOf(server), providers } })) })} /></SettingsRow>)}
            <SettingsRow title="Kanna sign-in" description="Shared by all enabled providers."><SettingsActionButton disabled={busy} onClick={() => void perform(async () => { setSnapshot(await socket.command<McpSnapshot>({ type: "mcp.disconnect", id: server.id })) })}>Sign out</SettingsActionButton></SettingsRow>
          </SettingsGroup>
        ))}</SettingsGroups>
      )}
      <p className="px-4 text-xs leading-5 text-muted-foreground">Provider changes apply with the next message. Grok does not yet support Kanna-managed MCPs. Provider-native servers remain available through their existing configurations.</p>
    </div>
  )
}
