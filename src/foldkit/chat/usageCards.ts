import type { Html, HtmlBuilder } from "foldkit/html"
import { formatRelativeTime } from "../../client/lib/formatters"
import { cn } from "../../client/lib/utils"
import { PROVIDERS, type ProviderUsageSnapshot, type UsageLimitWindow } from "../../shared/types"
import type { AppModel } from "../app/slice"
import * as ChatPreferences from "../core/stores/chatPreferences"
import { ChevronRight } from "../ui/icons"
import { PROVIDER_ICONS } from "../ui/provider-icons"
import * as Tooltip from "../ui/tooltip"
import { Message } from "./message"
import type { Model } from "./model"

// EmptyStateUsageCards (ChatPage/EmptyStateUsageCards.tsx): the harness
// usage meters on a phone's new chat page, for the providers with live limit
// data, the composer's provider first. Each is Settings' ProviderCard
// (settings/UsageSection.tsx, a React file: what the collapsible card draws
// is restated here), starting collapsed with its first window's meter in the
// header. Display-only: refreshing lives on Settings → Usage.

type H = HtmlBuilder<Message>

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "in 40m" / "in 3h" / "in 2d". */
function formatUntil(isoTimestamp: string): string | null {
  const timestamp = Date.parse(isoTimestamp)
  if (!Number.isFinite(timestamp)) return null
  const delta = timestamp - Date.now()
  if (delta <= 0) return "now"
  if (delta < HOUR_MS) return `in ${Math.max(1, Math.round(delta / MINUTE_MS))}m`
  if (delta < DAY_MS) return `in ${Math.round(delta / HOUR_MS)}h`
  return `in ${Math.round(delta / DAY_MS)}d`
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  if (value > 0 && value < 1) return "<1%"
  return `${Math.round(value)}%`
}

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

function providerLabel(providerId: string): string {
  return PROVIDERS.find((entry) => entry.id === providerId)?.label ?? providerId
}

function accountScopeLabel(plan: string | null): string | null {
  if (!plan) return null
  const value = plan.toLowerCase()
  if (/team|business|enterprise|edu/.test(value)) return "Enterprise"
  if (/free|go|plus|pro|prolite|max/.test(value)) return "Personal"
  return null
}

function planLabel(snapshot: ProviderUsageSnapshot): string {
  return [accountScopeLabel(snapshot.plan), snapshot.plan].filter(Boolean).join(" ")
}

function barColorClass(usedPercent: number | null): string {
  if (usedPercent === null) return "bg-muted-foreground/40"
  if (usedPercent >= 90) return "bg-red-500"
  if (usedPercent >= 75) return "bg-amber-500"
  return "bg-emerald-500"
}

function usageBar(usedPercent: number | null, h: H): Html {
  const width = usedPercent === null ? 0 : Math.max(usedPercent > 0 ? 1.5 : 0, Math.min(100, usedPercent))
  return h.div([h.Class("h-2 w-full overflow-hidden rounded-full bg-muted")], [
    h.div([h.Class(cn("h-full rounded-full transition-[width] duration-500 ease-out", barColorClass(usedPercent))), h.Style({ width: `${width}%` })], []),
  ])
}

const WINDOW_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_5rem_minmax(4rem,1.4fr)_2.375rem] items-center gap-3"

const COLLAPSED_HEADER_GRID = cn(
  "grid grid-cols-[minmax(0,1fr)_minmax(4rem,1fr)_2.375rem] items-center gap-3",
  "md:grid-cols-[minmax(0,1fr)_5rem_minmax(4rem,1fr)_2.375rem]",
)

function resetTime(resets: string | null, className: string | undefined, h: H): Html {
  if (!resets) return h.div(className ? [h.Class(className)] : [], [])
  return h.div([h.Class(cn("truncate text-xs text-muted-foreground", className))], [`Resets ${resets}`])
}

function windowRow(window: UsageLimitWindow, h: H): Html {
  const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
  return h.keyed("div")(window.id, [h.Class(WINDOW_ROW_GRID)], [
    h.div([h.Class("min-w-0 truncate text-sm text-foreground")], [window.label]),
    resetTime(resets, undefined, h),
    usageBar(window.usedPercent, h),
    h.div([h.Class(cn("tabular-nums", "text-right text-sm font-medium text-foreground"))], [formatPercent(window.usedPercent)]),
  ])
}

function usageWindowRows(snapshot: ProviderUsageSnapshot, h: H): Html {
  return h.div([h.Class(cn("space-y-2.5", "mt-4"))], [
    ...snapshot.windows.map((window) => windowRow(window, h)),
    snapshot.credits
      ? h.div([h.Class("flex items-baseline justify-between gap-3 border-t border-border pt-3 text-sm")], [
        h.span([h.Class("text-foreground")], [snapshot.credits.label]),
        h.span([h.Class("text-muted-foreground")], [creditsSummary(snapshot.credits) ?? ""]),
      ])
      : null,
    snapshot.detail ? h.div([h.Class("text-xs text-muted-foreground")], [snapshot.detail]) : null,
  ])
}

/** A card's open/closed state, per chat page (each new chat's cards start closed). */
export const usageCardKey = (chatId: string | null, provider: string) => `${chatId ?? ""}:${provider}`

export function usageTooltip(model: Model, provider: string): Tooltip.Model {
  return model.usageCards.tooltips[provider] ?? Tooltip.init({ id: `usage-card-${provider}`, delayDuration: 0 })
}

/** ProviderCard, collapsible: the card toggles open on a click anywhere on it. */
function providerCard(model: Model, chatId: string | null, snapshot: ProviderUsageSnapshot, h: H): Html {
  const Icon = PROVIDER_ICONS[snapshot.provider]
  const hasContent = snapshot.windows.length > 0 || snapshot.credits
  const expanded = model.usageCards.expanded[usageCardKey(chatId, snapshot.provider)] === true
  const timestampText = snapshot.updatedAt ? `Updated ${formatRelativeTime(snapshot.updatedAt)}` : null
  const timestampNode = timestampText === null ? null : h.span([h.Class("shrink-0 text-xs text-muted-foreground")], [timestampText])
  const planBadgeText = planLabel(snapshot)

  const identity = h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
    // Harness icon by default; on card hover it cross-fades to a chevron.
    h.span([h.Class("relative flex h-4 w-4 shrink-0 items-center justify-center")], [
      Icon({ class: "absolute inset-0 h-4 w-4 text-foreground transition-[opacity,scale,filter] duration-150 ease-out opacity-100 scale-100 blur-none group-hover/usage-card:opacity-0 group-hover/usage-card:scale-75 group-hover/usage-card:blur-[1px]" }, h),
      ChevronRight({
        class: cn(
          "absolute inset-0 h-4 w-4 text-muted-foreground transition-[opacity,scale,filter,rotate] duration-150 ease-out opacity-0 scale-75 blur-[1px] group-hover/usage-card:opacity-100 group-hover/usage-card:scale-100 group-hover/usage-card:blur-none",
          expanded ? "rotate-90" : undefined,
        ),
      }, h),
    ]),
    h.span([h.Class("min-w-0 truncate text-sm font-semibold text-foreground")], [providerLabel(snapshot.provider)]),
    planBadgeText
      ? h.span([h.Class("min-w-0 shrink truncate rounded-full border border-border px-2 py-0.5 text-[11px] capitalize text-muted-foreground")], [planBadgeText])
      : null,
  ])

  const summaryWindow = snapshot.windows[0] ?? null
  const summaryResets = summaryWindow?.resetsAt ? formatUntil(summaryWindow.resetsAt) : null

  const header = expanded
    ? h.div([h.Class("flex items-center justify-between gap-3")], [identity, timestampNode])
    : h.div([h.Class(COLLAPSED_HEADER_GRID)], [
      identity,
      resetTime(summaryResets, "hidden md:block", h),
      summaryWindow
        ? h.submodel({
          slotId: `usage-tooltip-${snapshot.provider}`,
          model: usageTooltip(model, snapshot.provider),
          view: Tooltip.view,
          viewInputs: {
            side: "top",
            align: "center",
            content: () => [
              h.div([], [summaryWindow.label]),
              timestampText ? h.div([h.Class("text-muted-foreground")], [timestampText]) : null,
            ].filter((child): child is Html => child !== null),
            // Padding widens the 8px bar's hover target without adding height.
            toView: ({ trigger, portal }) => h.div([h.Class("min-w-0 py-1.5"), ...trigger], [usageBar(summaryWindow.usedPercent, h), portal]),
          },
          toParentMessage: (message) => Message.GotUsageTooltipMessage({ provider: snapshot.provider, message }),
        })
        : h.div([], []),
      h.div([h.Class("text-right text-sm font-medium tabular-nums text-foreground")], [summaryWindow ? formatPercent(summaryWindow.usedPercent) : ""]),
    ])

  const body = expanded
    ? hasContent
      ? usageWindowRows(snapshot, h)
      : h.div([h.Class("mt-3 text-sm text-muted-foreground")], [
        snapshot.detail ?? (snapshot.status === "unknown" ? "No usage recorded yet." : "Usage limits are not available."),
      ])
    : null

  return h.keyed("button")(snapshot.provider, [
    h.Type("button"),
    h.OnClick(Message.ClickedUsageCard({ provider: snapshot.provider })),
    h.AriaExpanded(expanded),
    h.Class(cn("group/usage-card block w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left", "cursor-pointer")),
  ], [header, body])
}

/**
 * The cards, or nothing when no provider has live limit data (Claude and
 * Codex signed in with a subscription). The composer's provider for this
 * chat first, then the rest in their order.
 */
export function usageCardsView(model: Model, app: AppModel, chatId: string | null, h: H): Html | null {
  const withData = (model.usageLimits?.providers ?? []).filter((provider) => provider.status === "ok" && provider.windows.length > 0)
  if (withData.length === 0) return null
  const composerChatId = chatId ?? ChatPreferences.NEW_CHAT_COMPOSER_ID
  const selectedProvider = ChatPreferences.getComposerState(app.stores.chatPreferences, app.stores.sidebar.data, composerChatId).provider
  const cards = [...withData].sort((a, b) => (a.provider === selectedProvider ? 0 : 1) - (b.provider === selectedProvider ? 0 : 1))
  return h.div([h.Class("w-full space-y-3 text-left")], cards.map((provider) => providerCard(model, chatId, provider, h)))
}
