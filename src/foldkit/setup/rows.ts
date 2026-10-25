import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { MacSetupState } from "../core/macApp"
import type { Child } from "../ui/attributes"
import { button } from "../ui/button"
import { Check, Coffee, HardDrive, Power } from "../ui/icons"
import { switchControl } from "../ui/switch"

// The wizard's rows and the This Mac step (components/auth/MacSetupStep.tsx):
// SetupList, SetupRow, PillButton, Done and MacSetupCards, as plain views.
//
// The This Mac step shows only in Kanna for Mac, on this Mac's own server:
// Open at Login, staying awake, and Full Disk Access. The page draws it; the
// app does each thing and reports back (macos/src/mac-setup.ts). A browser,
// or an app older than the step, never sees it.

/** Nothing left to do: the step can be skipped on open. */
export function macSetupSatisfied(state: MacSetupState | null) {
  return state !== null && state.loginItem === "enabled" && state.fullDiskAccess
}

/**
 * The wizard's card: rows in one rounded card with hairlines between them,
 * the way Settings groups its rows (app/settings/shared.tsx
 * SETTINGS_LIST_CARD_CLASS), rather than a stack of separate boxes.
 */
export const SETUP_LIST_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40 text-left"

export function setupList<M>(options: { class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.div([h.DataAttribute("setup-list", "true"), h.Class(cn(SETUP_LIST_CLASS, options.class))], children)
}

export interface SetupRowOptions {
  icon?: Html
  title: string
  detail?: Child
  tone?: "muted" | "warn"
  action: Child
  nested?: boolean
  /** Skipped or not done: the row steps back. */
  muted?: boolean
  class?: string
}

/** One row: icon, a title with at most one short line under it, and its control. */
export function setupRow<M>(options: SetupRowOptions, h: HtmlBuilder<M>): Html {
  const { icon, title, detail, action } = options
  const tone = options.tone ?? "muted"
  const nested = options.nested ?? false
  const muted = options.muted ?? false
  return h.div([h.Class(cn("flex items-center gap-3 px-4 py-3", nested && "pl-11", options.class))], [
    icon
      ? h.span([h.Class(cn("flex size-4 shrink-0 items-center justify-center", muted ? "text-muted-foreground/50" : "text-foreground"))], [icon])
      : null,
    h.div([h.Class("min-w-0 flex-1")], [
      h.div([h.Class(cn("truncate text-sm", nested || muted ? "text-muted-foreground" : "font-medium text-foreground"))], [title]),
      detail
        ? h.div([h.Class(cn("mt-0.5 text-xs", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"))], [detail])
        : null,
    ]),
    h.div([h.Class("flex shrink-0 items-center")], [action]),
  ])
}

export function pillButton<M>(onClick: M, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return button({
    variant: "outline",
    size: "sm",
    class: "h-7 shrink-0 rounded-full px-3 text-xs font-semibold transition-[transform,background-color] duration-150 ease-out active:scale-[0.96]",
    attributes: [h.OnClick(onClick)],
  }, children, h)
}

/** The check a row lands on; it settles in rather than blinking on. */
export function done<M>(h: HtmlBuilder<M>): Html {
  return h.span([h.Class("flex size-7 items-center justify-center"), h.Title("Done")], [
    Check({ class: "size-4 text-emerald-500 animate-in fade-in zoom-in-90 duration-200 ease-out" }, h),
  ])
}

/** What to do in System Settings once Open Settings takes you there. */
export const FULL_DISK_ACCESS_STEPS = "Click +, then choose Kanna."

/** What each control of the step sends, as Messages of the owner. */
export interface MacSetupMessages<M> {
  openLoginItems: M
  setLoginItem: (enabled: boolean) => M
  setKeepAwake: (onPower: boolean) => M
  setKeepAwakeOnBattery: (onBattery: boolean) => M
  openFullDiskAccess: M
}

export function macSetupCards<M>(state: MacSetupState | null, messages: MacSetupMessages<M>, h: HtmlBuilder<M>): Html {
  if (!state) {
    return h.p([h.Class("text-center text-sm text-muted-foreground")], ["Checking this Mac…"])
  }
  const iconClass = "size-4"

  return setupList({}, [
    setupRow({
      icon: Power({ class: iconClass }, h),
      title: "Open at login",
      detail: state.loginItem === "requiresApproval" ? "Approve Kanna in Login Items." : "Back after a restart.",
      tone: state.loginItem === "requiresApproval" ? "warn" : "muted",
      action: state.loginItem === "requiresApproval"
        ? pillButton(messages.openLoginItems, ["Open"], h)
        : switchControl({
          ariaLabel: "Open at login",
          checked: state.loginItem === "enabled",
          onCheckedChange: messages.setLoginItem,
        }, h),
    }, h),
    setupRow({
      icon: Coffee({ class: iconClass }, h),
      title: "Stay awake",
      detail: state.lidClosingSleeps ? "Closing the lid still sleeps it." : "While plugged in.",
      tone: state.lidClosingSleeps ? "warn" : "muted",
      action: switchControl({
        ariaLabel: "Stay awake while plugged in",
        checked: state.keepAwakeOnPower,
        onCheckedChange: messages.setKeepAwake,
      }, h),
    }, h),
    state.keepAwakeOnPower
      ? setupRow({
        nested: true,
        // Opens out of the row above it, the switch that made it appear.
        class: "animate-in fade-in slide-in-from-top-1 duration-200 ease-out",
        title: "Also on battery",
        action: switchControl({
          ariaLabel: "Also on battery",
          checked: state.keepAwakeOnBattery,
          onCheckedChange: messages.setKeepAwakeOnBattery,
        }, h),
      }, h)
      : null,
    setupRow({
      icon: HardDrive({ class: iconClass }, h),
      title: "Full Disk Access",
      detail: state.fullDiskAccess ? "Agents reach every folder." : FULL_DISK_ACCESS_STEPS,
      action: state.fullDiskAccess ? done(h) : pillButton(messages.openFullDiskAccess, ["Open Settings"], h),
    }, h),
  ], h)
}
