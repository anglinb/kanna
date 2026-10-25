import type { Html } from "foldkit/html"
import { formatRelativeTime } from "../../client/lib/formatters"
import { cn } from "../../client/lib/utils"
import type { AgentProvider, ProviderUsageSnapshot, UsageLimitsSnapshot, UsageLimitWindow } from "../../shared/types"
import { formatPercent, formatUntil, planLabel, providerLabel, usageBar } from "../settings/usage"
import { buttonClass } from "../ui/button"
import { LoaderCircle, RefreshCw } from "../ui/icons"
import { PROVIDER_ICONS } from "../ui/provider-icons"
import { tooltip, type ColumnContext, type H } from "./context"
import { Message } from "./message"
import { widgetCard, widgetPresence, widgetStatic } from "./parts"

// UsageWidgets (widgets/UsageWidget.tsx): usage limits, one card per
// harness that reports any. In a chat only the selected harness shows; a new
// chat shows them all, selected first. The snapshot is the page's
// (`page.widgetsData`); the refresh button's own read is this column's.

type ProviderUsage = UsageLimitsSnapshot["providers"][number]

function hasUsageContent(usage: ProviderUsage) {
  return usage.windows.length > 0 || Boolean(usage.credits)
}

// From settings/UsageSection.tsx (a React file): credits' summary.

function currencySymbol(currency: string | null): string {
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD", maximumFractionDigits: 0 }).formatToParts(0)
    return parts.find((part) => part.type === "currency")?.value ?? ""
  } catch {
    return ""
  }
}

function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  const unit = (scaled: number, suffix: string) => `${sign}${scaled.toLocaleString("en-US", { maximumFractionDigits: 1 })}${suffix}`
  if (abs >= 1_000_000) return unit(abs / 1_000_000, "m")
  if (abs >= 1_000) return unit(abs / 1_000, "k")
  return `${sign}${Math.round(abs)}`
}

function formatMoney(amount: number, currency: string | null): string {
  const compact = formatCompact(amount)
  const symbol = currencySymbol(currency)
  return compact.startsWith("-") ? `-${symbol}${compact.slice(1)}` : `${symbol}${compact}`
}

function creditsSummary(credits: NonNullable<ProviderUsageSnapshot["credits"]>): string | null {
  const parts: string[] = []
  if (credits.usedAmount != null) {
    const used = formatMoney(credits.usedAmount, credits.currency)
    parts.push(credits.limitAmount != null ? `${used} of ${formatMoney(credits.limitAmount, credits.currency)} used` : `${used} used`)
  }
  if (credits.usedPercent != null) parts.push(`${formatPercent(credits.usedPercent)} used`)
  if (credits.detail) {
    const numeric = /^\d+(\.\d+)?$/.test(credits.detail.trim()) ? Number(credits.detail) : null
    parts.push(numeric !== null ? `${formatCompact(numeric)} credits remaining` : credits.detail)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

// The widget column's rows: a bare reset time ("2h"), a narrower bar, the
// percent right-aligned so the numbers line up down the card.
const COMPACT_WINDOW_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_1.75rem_minmax(2.4rem,0.84fr)_2.25rem] items-center gap-2"

function compactWindowRow(context: ColumnContext, provider: string, window: UsageLimitWindow, h: H): Html {
  const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
  return h.keyed("div")(window.id, [h.Class(COMPACT_WINDOW_ROW_GRID)], [
    h.div([h.Class("min-w-0 truncate text-sm text-foreground")], [window.label]),
    resets
      ? tooltip(context.model, `usage-reset-${provider}-${window.id}`, {
        side: "top",
        align: "center",
        content: () => [`Resets ${resets}`],
        toView: ({ trigger, portal }) => h.div([...trigger, h.Class("truncate text-xs text-muted-foreground")], [resets.replace(/^in /, ""), portal]),
      }, h)
      : h.div([], []),
    usageBar(window.usedPercent, h),
    h.div([h.Class(cn("tabular-nums", "text-right text-xs text-muted-foreground"))], [formatPercent(window.usedPercent)]),
  ])
}

function usageWindowRows(context: ColumnContext, snapshot: ProviderUsage, h: H): Html {
  return h.div([h.Class("space-y-2.5")], [
    ...snapshot.windows.map((window) => compactWindowRow(context, snapshot.provider, window, h)),
    snapshot.credits
      ? h.div([h.Class("flex items-baseline justify-between gap-3 border-t border-border pt-3 text-sm")], [
        h.span([h.Class("text-foreground")], [snapshot.credits.label]),
        h.span([h.Class("text-muted-foreground")], [creditsSummary(snapshot.credits) ?? ""]),
      ])
      : null,
    snapshot.detail ? h.div([h.Class("text-xs text-muted-foreground")], [snapshot.detail]) : null,
  ])
}

/** The snapshot the cards show: the refresh button's answer while the page's is the one it answered. */
export function usageSnapshot(context: ColumnContext): UsageLimitsSnapshot | null {
  const page = context.page.widgetsData.usageLimits
  const override = context.model.usageOverride
  return override && override.basis === usageBasis(page) ? override.snapshot : page
}

/** A fingerprint of the page's snapshot, so a newer push wins over an older answer. */
export function usageBasis(snapshot: UsageLimitsSnapshot | null): string {
  return snapshot ? JSON.stringify(snapshot.providers.map((provider) => [provider.provider, provider.updatedAt ?? null])) : ""
}

function usageWidget(context: ColumnContext, usage: ProviderUsage, show: boolean, refreshing: boolean, h: H): Html {
  const { model } = context
  const provider = usage.provider
  const expanded = context.expanded(`usage:${provider}` as `usage:${AgentProvider}`, usage.windows.length)
  const Icon = PROVIDER_ICONS[provider]
  const summaryWindow = usage.windows[0] ?? null
  const summaryResets = summaryWindow?.resetsAt ? formatUntil(summaryWindow.resetsAt) : null
  const plan = planLabel(usage)
  const updated = usage.updatedAt ? `Updated ${formatRelativeTime(usage.updatedAt)}` : null
  const basis = usageBasis(context.page.widgetsData.usageLimits)

  const collapsedSummary = summaryWindow
    ? [tooltip(model, `usage-summary-${provider}`, {
      side: "top",
      align: "center",
      content: () => [
        h.div([], [summaryWindow.label]),
        summaryResets ? h.div([h.Class("text-muted-foreground")], [`Resets ${summaryResets}`]) : null,
      ],
      toView: ({ trigger, portal }) => h.div([...trigger, h.Class("flex items-center gap-2 pr-1")], [
        // Bare ("2h"); the tooltip says "Resets in 2h".
        summaryResets ? h.span([h.Class("text-xs tabular-nums text-muted-foreground")], [summaryResets.replace(/^in /, "")]) : null,
        h.div([h.Class("w-16 py-1.5")], [usageBar(summaryWindow.usedPercent, h)]),
        h.span([h.Class("w-8 text-right text-xs tabular-nums text-muted-foreground")], [formatPercent(summaryWindow.usedPercent)]),
        portal,
      ]),
    }, h)]
    : null

  // The Branch card's Fetch button, glyph and all.
  const refreshButton = [tooltip(model, `usage-refresh-${provider}`, {
    content: () => [refreshing ? "Refreshing…" : updated ?? "Refresh usage"],
    toView: ({ trigger, portal }) => h.button([
      h.Class(buttonClass({ variant: "ghost", size: "sm", class: "h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground hover:!bg-transparent hover:!border-border/0" })),
      h.AriaLabel("Refresh usage"),
      ...(refreshing ? [h.Disabled(true)] : []),
      ...trigger,
      h.OnClick(Message.ClickedRefreshUsage({ basis })),
    ], [refreshing ? LoaderCircle({ class: "size-3.5 animate-spin" }, h) : RefreshCw({ class: "size-3.5" }, h), portal]),
  }, h)]

  return widgetPresence({ key: `usage-${provider}`, show }, [
    widgetCard({
      icon: Icon({}, h),
      title: [providerLabel(provider)],
      // Muted after the title, like the Branch card's branch name.
      count: expanded && plan ? [h.span([h.Class("capitalize")], [plan])] : null,
      expanded,
      onToggle: Message.ToggledUsage({ provider }),
      actions: expanded ? refreshButton : collapsedSummary,
      body: [widgetStatic({}, [usageWindowRows(context, usage, h)], h)],
    }, h),
  ], h)
}

export function usageWidgets(context: ColumnContext, selectedProvider: AgentProvider, h: H): ReadonlyArray<Html> {
  const snapshot = usageSnapshot(context)
  const providers = snapshot?.providers ?? []
  const ordered = [
    ...providers.filter((usage) => usage.provider === selectedProvider),
    ...providers.filter((usage) => usage.provider !== selectedProvider),
  ]
  const refreshing = context.page.widgetsData.usageRefreshing || context.model.usageRefreshing
  const showAll = context.page.isNewChat
  return ordered.map((usage) => usageWidget(context, usage, hasUsageContent(usage) && (showAll || usage.provider === selectedProvider), refreshing, h))
}
