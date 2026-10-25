import { Duration, Effect, Schema, Stream } from "effect"
import { Command, Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { formatRelativeTime } from "../../client/lib/formatters"
import { cn } from "../../client/lib/utils"
import { PROVIDERS, type ProviderUsageSnapshot, type UsageLimitWindow, type UsageLimitsSnapshot } from "../../shared/types"
import { opaque } from "../core/schema"
import { sendCommand, topicStream, type KannaSocketService } from "../core/socket"
import { PROVIDER_ICONS } from "../ui/provider-icons"
import * as Tooltip from "../ui/tooltip"

// The Usage… page: app/settings/UsageSection.tsx (UsageSection, the
// non-collapsible ProviderCard and useUsageLimits), copied: it is a React
// component. The settings slice ports the same section for its page; the
// two can share one once both are merged.

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "in 40m" / "in 3h" / "in 2d" — future counterpart of formatRelativeTime. */
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

/** The currency symbol for a code ("$"), or "" for codes Intl doesn't know. */
function currencySymbol(currency: string | null): string {
  try {
    const parts = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      maximumFractionDigits: 0,
    }).formatToParts(0)
    return parts.find((part) => part.type === "currency")?.value ?? ""
  } catch {
    return ""
  }
}

/** Rounded and abbreviated above a thousand: 130.42 → "130", 2000 → "2k", 7051.8 → "7.1k". */
function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  const unit = (scaled: number, suffix: string) =>
    `${sign}${scaled.toLocaleString("en-US", { maximumFractionDigits: 1 })}${suffix}`
  if (abs >= 1_000_000) return unit(abs / 1_000_000, "m")
  if (abs >= 1_000) return unit(abs / 1_000, "k")
  return `${sign}${Math.round(abs)}`
}

/** Whole-dollar money, abbreviated above a thousand: "$130", "$1.3k", "$2k", "$1.2m". */
function formatMoney(amount: number, currency: string | null): string {
  const compact = formatCompact(amount)
  const symbol = currencySymbol(currency)
  // Keep the symbol ahead of the sign: -$5, not $-5.
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
    // Codex reports its prepaid balance as a bare numeric string ("1000").
    const numeric = /^\d+(\.\d+)?$/.test(credits.detail.trim()) ? Number(credits.detail) : null
    parts.push(numeric !== null ? `${formatCompact(numeric)} credits remaining` : credits.detail)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

function providerLabel(providerId: string): string {
  return PROVIDERS.find((entry) => entry.id === providerId)?.label ?? providerId
}

/** Personal vs org-managed account scope, from the plan string. */
function accountScopeLabel(plan: string | null): string | null {
  if (!plan) return null
  const value = plan.toLowerCase()
  if (/team|business|enterprise|edu/.test(value)) return "Enterprise"
  if (/free|go|plus|pro|prolite|max/.test(value)) return "Personal"
  return null
}

function barColorClass(usedPercent: number | null): string {
  if (usedPercent === null) return "bg-muted-foreground/40"
  if (usedPercent >= 90) return "bg-red-500"
  if (usedPercent >= 75) return "bg-amber-500"
  return "bg-emerald-500"
}

function usageBar<Message>(usedPercent: number | null, h: HtmlBuilder<Message>): Html {
  const width = usedPercent === null ? 0 : Math.max(usedPercent > 0 ? 1.5 : 0, Math.min(100, usedPercent))
  return h.div([h.Class("h-2 w-full overflow-hidden rounded-full bg-muted")], [
    h.div([
      h.Class(cn("h-full rounded-full transition-[width] duration-500 ease-out", barColorClass(usedPercent))),
      h.Style({ width: `${width}%` }),
    ]),
  ])
}

const WINDOW_ROW_GRID = "grid grid-cols-[minmax(0,1fr)_5rem_minmax(4rem,1.4fr)_2.375rem] items-center gap-3"

function windowRow<Message>(window: UsageLimitWindow, h: HtmlBuilder<Message>): Html {
  const resets = window.resetsAt ? formatUntil(window.resetsAt) : null
  return h.keyed("div")(window.id, [h.Class(WINDOW_ROW_GRID)], [
    h.div([h.Class("min-w-0 truncate text-sm text-foreground")], [window.label]),
    resets ? h.div([h.Class("truncate text-xs text-muted-foreground")], [`Resets ${resets}`]) : h.div([]),
    usageBar(window.usedPercent, h),
    h.div([h.Class(cn("tabular-nums", "text-right text-sm font-medium text-foreground"))], [formatPercent(window.usedPercent)]),
  ])
}

/** Scope and plan as one label ("Personal max"), or "" when neither is known. */
function planLabel(snapshot: ProviderUsageSnapshot): string {
  return [accountScopeLabel(snapshot.plan), snapshot.plan].filter(Boolean).join(" ")
}

function usageWindowRows<Message>(snapshot: ProviderUsageSnapshot, className: string, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(cn("space-y-2.5", className))], [
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

// MODEL (useUsageLimits)

const Snapshot = opaque<UsageLimitsSnapshot>("UsageLimitsSnapshot")

export const Model = Schema.Struct({
  /** The page is showing: the subscription and the poll run. */
  active: Schema.Boolean,
  snapshot: Schema.NullOr(Snapshot),
  /** An open view refreshes the moment it mounts, so it starts out refreshing. */
  refreshing: Schema.Boolean,
  /** One per provider card: its "Updated …" refresh control's tooltip. */
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
})
export type Model = typeof Model.Type

export function init(): Model {
  return { active: false, snapshot: null, refreshing: true, tooltips: {} }
}

export const Message = defineMessageUnion({
  ReceivedUsageLimits: { snapshot: Snapshot },
  ElapsedPoll: {},
  ClickedRefresh: {},
  CompletedRefresh: { snapshot: Schema.NullOr(Snapshot) },
  GotTooltipMessage: { provider: Schema.String, message: Tooltip.Message },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, KannaSocketService>

/** How often an open usage view re-checks; server-side TTL coalesces the reads. */
const USAGE_POLL_MS = 60_000

export const RefreshUsage = Command.define("RefreshPaletteUsage", {
  args: { force: Schema.Boolean },
  messages: [Message.CompletedRefresh],
  execute: ({ force }) => sendCommand<UsageLimitsSnapshot>({ type: "usage.refresh", force }).pipe(
    Effect.map((result) => Message.CompletedRefresh({ snapshot: result && Array.isArray(result.providers) ? result : null })),
    // Errors surface as "unavailable" provider states in the snapshot.
    Effect.catch(() => Effect.succeed(Message.CompletedRefresh({ snapshot: null }))),
  ),
})

function refresh(model: Model, force: boolean): Return {
  return { model: { ...model, refreshing: true }, commands: [RefreshUsage({ force })] }
}

/** The section mounted (the page was pushed): it refreshes at once. */
export function mounted(): Return {
  return refresh({ ...init(), active: true }, false)
}

/** The section unmounted: its state goes with it. */
export function unmounted(): Model {
  return init()
}

const tooltipFor = (model: Model, provider: string) =>
  model.tooltips[provider] ?? Tooltip.init({ id: `palette-usage-refresh-${provider}`, delayDuration: 0 })

export function update(model: Model, message: Message): Return {
  return Message.match<Return>(message, {
    ReceivedUsageLimits: ({ snapshot }) => ({ model: model.active ? { ...model, snapshot } : model }),
    ElapsedPoll: () => (model.active ? refresh(model, false) : { model }),
    ClickedRefresh: () => (model.refreshing ? { model } : refresh(model, true)),
    CompletedRefresh: ({ snapshot }) => ({
      model: model.active ? { ...model, refreshing: false, snapshot: snapshot ?? model.snapshot } : model,
    }),
    GotTooltipMessage: ({ provider, message: child }) => {
      const result = Tooltip.update(tooltipFor(model, provider), child)
      return {
        model: { ...model, tooltips: { ...model.tooltips, [provider]: result.model } },
        commands: Command.mapMessages(result.commands, (tooltipMessage: Tooltip.Message) => Message.GotTooltipMessage({ provider, message: tooltipMessage })),
      }
    },
  })
}

/**
 * Subscribing gets the cached snapshot at once, and turn-pushed updates land
 * here while the view is open; every minute, while the page is visible, it
 * re-checks.
 */
export function streams(): Stream.Stream<Message, never, KannaSocketService> {
  return Stream.merge(
    topicStream<UsageLimitsSnapshot>({ type: "usage-limits" }).pipe(Stream.map((snapshot) => Message.ReceivedUsageLimits({ snapshot }))),
    Stream.tick(Duration.millis(USAGE_POLL_MS)).pipe(
      Stream.drop(1),
      Stream.filter(() => typeof document === "undefined" || document.visibilityState === "visible"),
      Stream.map(() => Message.ElapsedPoll()),
    ),
  )
}

// VIEW

function providerCard<ParentMessage>(model: Model, snapshot: ProviderUsageSnapshot, toParent: (message: Message) => ParentMessage, h: HtmlBuilder<ParentMessage>): Html {
  const Icon = PROVIDER_ICONS[snapshot.provider]
  const hasContent = snapshot.windows.length > 0 || snapshot.credits
  const timestampText = model.refreshing
    ? "Refreshing…"
    : snapshot.updatedAt
      ? `Updated ${formatRelativeTime(snapshot.updatedAt)}`
      : "Refresh"
  // The timestamp doubles as the refresh control.
  const timestampNode = h.submodel({
    slotId: `palette-usage-refresh-${snapshot.provider}`,
    model: tooltipFor(model, snapshot.provider),
    view: Tooltip.view,
    viewInputs: {
      content: () => ["Refresh usage"],
      side: "top",
      align: "center",
      toView: ({ trigger, portal }: Tooltip.RenderInfo) => h.button([
        ...trigger,
        h.Type("button"),
        h.OnClick(toParent(Message.ClickedRefresh())),
        h.Class("shrink-0 cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"),
      ], [timestampText, portal]),
    },
    toParentMessage: (message) => toParent(Message.GotTooltipMessage({ provider: snapshot.provider, message })),
  })
  const planBadgeText = planLabel(snapshot)
  return h.keyed("div")(snapshot.provider, [h.Class("group/usage-card block w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left")], [
    h.div([h.Class("flex items-center justify-between gap-3")], [
      h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
        Icon({ class: "h-4 w-4 shrink-0 text-foreground" }, h),
        h.span([h.Class("min-w-0 truncate text-sm font-semibold text-foreground")], [providerLabel(snapshot.provider)]),
        planBadgeText
          ? h.span([h.Class("min-w-0 shrink truncate rounded-full border border-border px-2 py-0.5 text-[11px] capitalize text-muted-foreground")], [planBadgeText])
          : null,
      ]),
      timestampNode,
    ]),
    hasContent
      ? usageWindowRows(snapshot, "mt-4", h)
      : h.div([h.Class("mt-3 text-sm text-muted-foreground")], [
        snapshot.detail
          ?? (snapshot.status === "unknown" ? "No usage recorded yet." : "Usage limits are not available."),
      ]),
  ])
}

/** `<div className="px-2 py-1.5"><UsageSection /></div>`. */
export function view<ParentMessage>(model: Model, toParent: (message: Message) => ParentMessage, h: HtmlBuilder<ParentMessage>): Html {
  return h.div([h.Class("px-2 py-1.5")], [
    h.div([h.Class("space-y-4")], model.snapshot
      // Always render whatever we have (cached/stale); the header "Updated …" is the control.
      ? model.snapshot.providers.map((provider) => providerCard(model, provider, toParent, h))
      : [h.div([h.Class("rounded-2xl border border-border bg-card/40 px-5 py-6 text-sm text-muted-foreground")], ["Loading usage…"])]),
  ])
}

