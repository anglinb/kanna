import type { Html, HtmlBuilder } from "foldkit/html"
import { toTitleCase } from "../../../client/lib/formatters"
import { cn } from "../../../client/lib/utils"
import { PROVIDERS, resolveModelLabel, type AgentProvider, type HydratedTranscriptMessage } from "../../../shared/types"
import type { Child } from "../../ui/attributes"
import type { Icon } from "../../ui/icon"
import { ArrowRightLeft, ChevronRight, RotateCw, Slash, UserRound } from "../../ui/icons"
import type { RowContext } from "./context"
import { keys, Message } from "./model"
import { PROVIDER_ICONS } from "./provider-icons"
import { defaultToolIcon, expandableRow, getToolIcon, metaLabel, metaPill, metaRow, metaText, toolIcons, verticalLineContainer } from "./shared"

/** SystemMessage.tsx: the session's provider and model, and what it was started with. */

export interface SessionHandoff {
  fromProvider: AgentProvider
  toProvider: AgentProvider
}

export interface SessionRestore {
  provider: AgentProvider
}

type SystemInit = Extract<HydratedTranscriptMessage, { kind: "system_init" }>

function providerLabel(provider: AgentProvider) {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider
}

function collapsibleSection(key: string, title: string, count: number, children: () => Child, context: RowContext, h: HtmlBuilder<Message>, badge?: Child): Html {
  if (count === 0) return null
  const open = Boolean(context.model.open[key])
  return h.div([h.Class("flex flex-col gap-1.5")], [
    h.button([h.OnClick(Message.ToggledOpen({ key })), h.Class("flex items-center gap-1 cursor-pointer group/section hover:opacity-60 transition-opacity")], [
      ChevronRight({ class: cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90") }, h),
      h.span([h.Class("text-muted-foreground font-medium")], [title]),
      h.span([h.Class("text-muted-foreground/60")], [String(count)]),
      badge ?? null,
    ]),
    open ? h.div([h.Class("ml-5")], [children()]) : null,
  ])
}

function pillSection(id: string, title: string, items: ReadonlyArray<string>, iconOf: (item: string) => Icon, context: RowContext, h: HtmlBuilder<Message>): Html {
  if (items.length === 0) return null
  return collapsibleSection(keys.systemSection(id, title), title, items.length, () => h.div([h.Class("flex flex-wrap gap-1.5")], items.map((item) => metaPill(iconOf(item), [item], h))), context, h)
}

/** Parse MCP tool name: "mcp__server__tool" → { server: "server", tool: "tool" } */
function parseMcpTool(name: string): { server: string; tool: string } | null {
  const match = name.match(/^mcp__([^_]+)__(.+)$/)
  if (!match) return null
  return { server: match[1]!, tool: match[2]! }
}

interface McpServerWithTools {
  name: string
  status: string
  error?: string
  tools: string[]
}

function statusDot(status: string, h: HtmlBuilder<Message>): Html {
  const color = status === "connected"
    ? "bg-emerald-500"
    : status === "pending"
      ? "bg-yellow-500"
      : "bg-red-500"
  return h.span([h.Class(cn("inline-block h-2 w-2 rounded-full shrink-0", color))], [])
}

function statusLabel(status: string): string {
  switch (status) {
    case "connected": return "Connected"
    case "failed": return "Failed"
    case "needs-auth": return "Needs auth"
    case "pending": return "Connecting..."
    case "disabled": return "Disabled"
    default: return status
  }
}

function mcpServerRow(id: string, server: McpServerWithTools, context: RowContext, h: HtmlBuilder<Message>): Html {
  const key = keys.mcpServer(id, server.name)
  const open = Boolean(context.model.open[key])
  const isConnected = server.status === "connected"
  const canOpen = isConnected && server.tools.length > 0
  return h.div([h.Class("flex flex-col gap-1.5")], [
    h.button([
      ...(canOpen ? [h.OnClick(Message.ToggledOpen({ key }))] : []),
      h.Class(cn("flex items-center gap-1.5", canOpen && "cursor-pointer hover:opacity-60 transition-opacity")),
    ], [
      canOpen ? ChevronRight({ class: cn("h-3 w-3 text-muted-foreground transition-transform duration-200", open && "rotate-90") }, h) : null,
      statusDot(server.status, h),
      h.span([h.Class("text-muted-foreground font-medium")], [toTitleCase(server.name)]),
      isConnected
        ? h.span([h.Class("text-muted-foreground/50")], [`${server.tools.length} tools`])
        : h.span([h.Class("text-muted-foreground/50")], [statusLabel(server.status)]),
    ]),
    !isConnected && server.error ? h.span([h.Class("text-destructive ml-5")], [server.error]) : null,
    open && server.tools.length > 0
      ? h.div([h.Class("flex flex-wrap gap-1.5 ml-5")], server.tools.map((tool) => metaPill(getToolIcon(`mcp__${server.name}__${tool}`), [tool], h)))
      : null,
  ])
}

function mcpServerSection(id: string, servers: ReadonlyArray<McpServerWithTools>, context: RowContext, h: HtmlBuilder<Message>): Html {
  if (servers.length === 0) return null
  const connected = servers.filter((server) => server.status === "connected")
  const disconnected = servers.filter((server) => server.status !== "connected")
  const badge = disconnected.length > 0
    ? h.span([h.Class("flex items-center gap-1 ml-1")], [
      statusDot("failed", h),
      h.span([h.Class("text-muted-foreground/60")], [`${disconnected.length} disconnected`]),
    ])
    : null
  return collapsibleSection(keys.systemSection(id, "MCP Servers"), "MCP Servers", servers.length, () => h.div([h.Class("flex flex-col gap-2")], [
    ...connected.map((server) => mcpServerRow(id, server, context, h)),
    ...disconnected.map((server) => mcpServerRow(id, server, context, h)),
  ]), context, h, badge)
}

/**
 * `rawJson` is used when the host already has the payload inline (export
 * bundles); otherwise it is fetched on first expand (`RequestedDebugRaw`),
 * since live snapshots omit `debugRaw`.
 */
function rawMessageSection(rawJson: string | undefined, entryId: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  const key = keys.systemSection(entryId, "Raw Message")
  const open = Boolean(context.model.open[key])
  const loaded = context.model.debugRaw[entryId]
  const state = loaded?.state ?? "idle"
  const body = rawJson ?? loaded?.body ?? null
  const needsFetch = rawJson === undefined && context.options.canLoadDebugRaw && (loaded === undefined || (loaded.state === "idle" && loaded.body === null))
  return h.div([h.Class("flex flex-col gap-1.5")], [
    h.button([
      h.OnClick(!open && needsFetch ? Message.OpenedRawMessage({ key, entryId }) : Message.ToggledOpen({ key })),
      h.Class("flex items-center gap-1 cursor-pointer group/section hover:opacity-60 transition-opacity"),
    ], [
      ChevronRight({ class: cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90") }, h),
      h.span([h.Class("text-muted-foreground font-medium")], ["Raw Message"]),
    ]),
    open
      ? h.pre([h.Class("ml-5 text-xs whitespace-pre-wrap break-all border border-border rounded-md p-3 overflow-x-auto max-h-96 overflow-y-auto")], [
        state === "loading" && body === null ? "Loading…" : null,
        state === "error" ? "Failed to load raw message." : null,
        state !== "error" ? body : null,
      ])
      : null,
  ])
}

export function systemMessage(
  message: SystemInit,
  options: {
    rawJson?: string
    /** Rendered mid-conversation because the model changed (rather than as the first session init). */
    modelChanged?: boolean
    /** This session init follows a harness switch: label it "From → To". */
    handoff?: SessionHandoff
    /** This session init follows a same-provider session restore: "Session Repaired". */
    restored?: SessionRestore
  },
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const { rawJson, modelChanged, handoff, restored } = options
  const iconProvider = handoff?.toProvider ?? message.provider
  const mcpToolsByServer = new Map<string, string[]>()
  const coreTools: string[] = []
  for (const tool of message.tools) {
    const parsed = parseMcpTool(tool)
    if (parsed) {
      const existing = mcpToolsByServer.get(parsed.server) || []
      existing.push(parsed.tool)
      mcpToolsByServer.set(parsed.server, existing)
    } else {
      coreTools.push(tool)
    }
  }
  const servers: McpServerWithTools[] = message.mcpServers.map((server) => ({
    name: server.name,
    status: server.status,
    error: server.error,
    tools: mcpToolsByServer.get(server.name) || [],
  }))

  const icon = restored && !handoff
    ? RotateCw({ class: "h-5 w-5 p-0.5 text-logo" }, h)
    : modelChanged && !handoff
      ? ArrowRightLeft({ class: "h-5 w-5 p-0.5 text-logo" }, h)
      : PROVIDER_ICONS[iconProvider]({ class: "h-5 w-5 p-0.5 text-logo", attributes: [h.DataAttribute("provider-icon", iconProvider)] }, h)

  // The row toggles open; a raw message section also opens from its own click below.
  return metaRow({}, [
    expandableRow(keys.system(message.id), context, [
      icon,
      metaLabel(undefined, [
        handoff
          ? providerLabel(handoff.toProvider)
          : restored
            ? "Session Repaired"
            : modelChanged ? "Model Changed" : providerLabel(message.provider),
        h.span([h.Class("ml-1.5 opacity-50 tracking-normal")], [
          resolveModelLabel(PROVIDERS.find((provider) => provider.id === message.provider)?.models, message.model),
        ]),
      ], h),
    ], () => verticalLineContainer("my-4 text-xs", [
      h.div([h.Class("flex flex-col gap-3")], [
        restored
          ? metaText([`${providerLabel(restored.provider)}'s saved session for this conversation was no longer available — coding-agent CLIs clean up old session files. Kanna repaired it by starting a fresh session and restoring the conversation from its own saved transcript.`], h)
          : null,
        metaText([message.model], h),
        pillSection(message.id, "Tools", coreTools, (tool) => toolIcons[tool] ?? defaultToolIcon, context, h),
        pillSection(message.id, "Agents", message.agents, () => UserRound, context, h),
        pillSection(message.id, "Commands", message.slashCommands, () => Slash, context, h),
        mcpServerSection(message.id, servers, context, h),
        // Inline payload (export bundles) or a loader (live snapshots,
        // which omit debugRaw); nothing to show without either.
        rawJson !== undefined || context.options.canLoadDebugRaw ? rawMessageSection(rawJson, message.id, context, h) : null,
      ]),
    ], h), h),
  ], h)
}
