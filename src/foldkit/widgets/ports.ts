import type { Html } from "foldkit/html"
import { formatPathWithTilde } from "../../client/lib/pathUtils"
import { cn } from "../../client/lib/utils"
import type { LocalHttpServerInfo } from "../../shared/protocol"
import { inputPopover, popoverMenuItem } from "../settings/preferenceControls"
import { Folder, Globe, Layers, ListFilter, Loader2, RadioTower } from "../ui/icons"
import { rowMenu, type ColumnContext, type H } from "./context"
import { Message } from "./message"
import { widgetCard, widgetError, widgetList, widgetPresence, widgetRow } from "./parts"

// PortsWidget (widgets/PortsWidget.tsx): local HTTP servers, opened in a new
// tab. Hidden while nothing is listening; the column keeps polling.

export const PORTS_POLL_INTERVAL_MS = 7_000

/** Whether this page is viewed on the machine itself (a loopback host). */
export function isLoopbackHost(hostname: string) {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "[::1]"
    || /^127(\.\d{1,3}){3}$/.test(hostname)
}

export function visiblePortServers(context: ColumnContext) {
  const ports = context.model.ports
  const projectServers = ports.servers.filter((server) => server.sameProject)
  const visible = ports.scope === "all" ? ports.servers : projectServers
  return { projectServers, visible }
}

function serverRow(context: ColumnContext, server: LocalHttpServerInfo, h: H): Html {
  const isExposing = context.model.ports.exposingPorts.includes(server.port)
  return widgetRow({
    key: server.address,
    icon: h.span([h.Class(cn("size-1.5 rounded-full", server.sameProject ? "bg-success" : "bg-muted-foreground/40"))], []),
    title: [h.span([h.Class("flex min-w-0 items-center gap-1.5")], [
      h.span([h.Class("min-w-0 truncate")], [server.title]),
      isExposing
        ? Loader2({ class: "size-3 shrink-0 animate-spin text-muted-foreground", attributes: [h.AriaLabel("Exposing")] }, h)
        : server.publicUrl ? Globe({ class: "size-3 shrink-0 text-info", attributes: [h.AriaLabel("Exposed to the internet")] }, h) : null,
    ])],
    subtitle: [
      isExposing ? "Exposing…" : server.publicUrl ?? server.address,
      !server.sameProject && server.ownerPath ? ` · ${formatPathWithTilde(server.ownerPath)}` : "",
    ],
    onActivate: Message.ClickedPort({ port: server.port }),
    ariaBusy: isExposing,
    menu: rowMenu(context.model, { _tag: "Port", port: server.port }, "Port actions", h),
  }, h)
}

export function portsWidget(context: ColumnContext, h: H): Html {
  const { model } = context
  const ports = model.ports
  const { projectServers, visible } = visiblePortServers(context)
  const otherServerCount = ports.servers.length - projectServers.length
  const expanded = context.expanded("ports", visible.length)
  return widgetPresence({ key: "ports", show: ports.error !== null || (ports.loaded && ports.servers.length > 0) }, [
    widgetCard({
      icon: RadioTower({}, h),
      title: ["Ports"],
      count: visible.length > 0
        ? visible.length
        : ports.scope === "project" && otherServerCount > 0 ? `${otherServerCount} elsewhere` : null,
      expanded: (visible.length > 0 && expanded) || ports.error !== null,
      ...(visible.length > 0
        ? { onToggle: Message.ToggledPorts() }
        : otherServerCount > 0 ? { onToggle: Message.ClickedPortsElsewhere() } : {}),
      actions: [
        // The same filter popover as the left sidebar's New Chat row.
        inputPopover({
          popover: ports.filter,
          slotId: "widgets-ports-filter",
          toParentMessage: (message) => Message.GotPortsFilterMessage({ message }),
          align: "end",
          triggerClassName: cn("size-6 justify-center rounded-md p-0 hover:text-foreground", ports.scope === "all" && "text-foreground"),
          trigger: [ListFilter({ class: "size-4 shrink-0", attributes: [h.AriaLabel("Filter ports")] }, h)],
          content: () => [
            popoverMenuItem({
              key: "project",
              onClick: Message.ChosePortsScope({ scope: "project" }),
              selected: ports.scope === "project",
              icon: Folder({ class: "h-4 w-4" }, h),
              label: ["This project"],
              description: `${projectServers.length} running`,
            }, h),
            popoverMenuItem({
              key: "all",
              onClick: Message.ChosePortsScope({ scope: "all" }),
              selected: ports.scope === "all",
              icon: Layers({ class: "h-4 w-4" }, h),
              label: ["All projects"],
              description: `${ports.servers.length} running`,
            }, h),
          ],
        }, h),
      ],
      body: visible.length > 0 || ports.error
        ? [widgetList({}, [
          ports.error ? widgetError(ports.error, h) : null,
          ...visible.map((server) => serverRow(context, server, h)),
        ], h)]
        : null,
    }, h),
  ], h)
}
