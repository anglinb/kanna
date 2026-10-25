import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../client/app/chatFocusPolicy"
import { isEscapeClaimed, resolveEscapePress, VIEWER_FIELDS_KEEP_ESCAPE_ATTRIBUTE } from "../../client/lib/escape-key"
import { cn } from "../../client/lib/utils"
import type { Child } from "../ui/attributes"
import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"
import * as Tooltip from "../ui/tooltip"
import { Message } from "./message"
import type { Model } from "./model"

/**
 * ViewerSurface (components/viewer/ViewerSurface.tsx): the viewer's chrome,
 * the one frame every full-size view sits in. A flat card, bordered like the
 * widget cards. On the chat page it opens in a pane of its own beside the
 * chat, and expands over the chat on request; elsewhere it covers the page.
 *
 * In a pane (docked or expanded) the card runs off the bottom of what it is
 * placed in: square bottom corners, no bottom border, nothing under it. On a
 * phone and in the export viewer it is an inset card with all four corners.
 *
 * One header grammar: what it is (icon, title, a muted subtitle), then the
 * view's own controls, then stepping between items when there are several,
 * then expand and close. The body scrolls; the header stays.
 *
 * Keys. Esc closes, from wherever focus is, the chat's composer included
 * (`lib/escape-key` has the whole order); it stands down only for what is
 * nearer the key. j/k (or ]/[) step when there's more than one item, but
 * never while you're typing in a field; in a pane beside the chat they're
 * the viewer's only while focus is in it.
 */

type H = HtmlBuilder<Message>

/**
 * Bottom padding for content that scrolls in the card and would otherwise end
 * hard on the window's edge where the card runs off it.
 */
export const VIEWER_END_PAD_CLASS = "group-data-[bleed]/viewer:pb-4"

/** The body's fade, as classes for whatever is mounting with new content. */
export const VIEWER_BODY_ENTER_CLASS = "transition-opacity duration-150 ease-snappy starting:opacity-0 motion-reduce:transition-none"

/** What the layer tells the card it places (ViewerLayer's providers). */
export interface LayerContext {
  /** The page gave the viewer a pane beside the chat (`ViewerPlacement`). */
  placement: { expanded: boolean } | null
  /** The pane has a floor under what is opened in it (`ViewerFloorState`). */
  floor: { hasBack: boolean; backLabel: string } | null
  /** What a card mounting now animates (`ViewerMotion`). */
  motion: { cardEnters: boolean; bodyEnters: boolean }
}

export interface ViewerNavigation {
  index: number
  count: number
  previousLabel?: string
  nextLabel?: string
  hasPrevious?: boolean
  hasNext?: boolean
}

export interface SurfaceConfig {
  /** Which card this is: a new key is a new card (React mounted a new component). */
  cardKey: string
  /** Names the region for assistive tech, e.g. "Review src/app.ts". */
  label: string
  icon?: Html | null
  title: Child
  subtitle?: Child | null
  toolbar?: ReadonlyArray<Html | null> | null
  center?: Html | null
  navigation?: ViewerNavigation | null
  leading?: Html | null
  body: ReadonlyArray<Child>
  bodyClassName?: string
  /** A body whose scroll is worth coming back to (`scroll-memory`). */
  scrollMemoryKey?: string
  quietFocus?: boolean
  fieldsKeepEscape?: boolean
}

/** The card's frame, shared with its stand-in so the two cannot drift. */
export function viewerCardClass(inPane: boolean, enters: boolean) {
  return cn(
    "group/viewer flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border outline-none",
    inPane && "origin-bottom rounded-b-none border-b-0",
    "bg-surface [--surface:var(--color-background)] dark:[--surface:var(--color-card)]",
    "transition-[opacity,scale] duration-200 ease-snappy",
    enters && "starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100",
  )
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
}

/**
 * What a key does to a card's navigation, or null for nothing: j or ] for
 * the next item, k or [ for the previous. Nothing for a key something
 * nearer has answered (a menu), one held with a modifier, one typed in a
 * field, or one with nowhere to step to.
 */
export function viewerNavigationStep(
  event: { key: string; defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  { navigation, typing }: { navigation: ViewerNavigation | undefined | null; typing: boolean },
): "next" | "previous" | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null
  if (!navigation || navigation.count < 2 || typing) return null
  if (event.key === "j" || event.key === "]") return navigation.hasNext === false ? null : "next"
  if (event.key === "k" || event.key === "[") return navigation.hasPrevious === false ? null : "previous"
  return null
}

// MOUNTS

/**
 * On the card: it says it mounted (and with what motion), takes focus, and
 * hears Escape at the window, capture phase, ahead of everything that would
 * take it on its way (the composer, its focus keeper, a tooltip).
 */
export const ViewerSurfaceMount = Mount.defineStream("ViewerSurface", {
  args: { key: Schema.String, cardEnters: Schema.Boolean, bodyEnters: Schema.Boolean, quietFocus: Schema.Boolean },
  messages: [Message.MountedCard, Message.PressedEscape],
  execute: ({ element, key, cardEnters, bodyEnters, quietFocus }) =>
    domStream<typeof Message.MountedCard.Type | typeof Message.PressedEscape.Type>((emit) => {
      const surface = element as HTMLElement
      emit(Message.MountedCard({ key, cardEnters, bodyEnters }))
      // Focus comes here on open, so its keys work at once and nothing behind
      // keeps it. A quiet card leaves focus where it is when that is outside the pane.
      const active = document.activeElement
      const keepFocus = quietFocus && active && active !== document.body && !active.closest("[data-viewer-surface]")
      if (!keepFocus) surface.focus({ preventScroll: true })

      const handleEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return
        // A card on its way out, or under another, is not the pane any more.
        if (!surface.isConnected || surface.closest("[inert]")) return
        const action = resolveEscapePress({
          repeat: event.repeat,
          claimed: isEscapeClaimed(event),
          paneOpen: true,
          canInterrupt: false,
        })
        if (action === "pass") return
        event.preventDefault()
        event.stopImmediatePropagation()
        if (action === "close-pane") emit(Message.PressedEscape())
      }
      window.addEventListener("keydown", handleEscape, true)
      return () => window.removeEventListener("keydown", handleEscape, true)
    }),
})

/**
 * j/k for a card that steps between items. Remounted with each change of
 * what it can step to (its key), so the listener always has the current
 * navigation, as React's effect re-ran on `navigation`.
 */
export const ViewerNavigationKeys = Mount.defineStream("ViewerNavigationKeys", {
  args: { count: Schema.Number, hasNext: Schema.Boolean, hasPrevious: Schema.Boolean, docked: Schema.Boolean },
  messages: [Message.PressedNavigationKey],
  execute: ({ element, count, hasNext, hasPrevious, docked }) =>
    domStream<typeof Message.PressedNavigationKey.Type>((emit) => {
      const navigation = { index: 0, count, hasNext, hasPrevious }
      const ownsKeys = () => {
        const surface = element.closest("[data-viewer-surface]")
        const active = document.activeElement
        if (surface?.contains(active)) return true
        return !docked && !isTypingTarget(active)
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        const step = viewerNavigationStep(event, { navigation, typing: isTypingTarget(event.target) })
        if (!step || !ownsKeys()) return
        event.preventDefault()
        emit(Message.PressedNavigationKey({ direction: step }))
      }
      window.addEventListener("keydown", handleKeyDown)
      return () => window.removeEventListener("keydown", handleKeyDown)
    }),
})

/** Where each remembered scroller was left, by key, for the life of the page (`scroll-memory`). */
const remembered = new Map<string, { top: number; left: number }>()

export function saveScroll(key: string, element: { scrollTop: number; scrollLeft: number }) {
  remembered.set(key, { top: element.scrollTop, left: element.scrollLeft })
}

/** Puts the scroller back where it was left. False when nothing was kept for it. */
export function restoreScroll(key: string, element: { scrollTop: number; scrollLeft: number }): boolean {
  const position = remembered.get(key)
  if (!position) return false
  element.scrollTop = position.top
  element.scrollLeft = position.left
  return true
}

/** Restores the body's scroll before paint and keeps it as it scrolls (`useScrollMemory`). */
export const ScrollMemory = Mount.defineStream("ViewerScrollMemory", {
  args: { key: Schema.String },
  messages: [Message.CompletedSideEffect],
  execute: ({ element, key }) =>
    domStream<typeof Message.CompletedSideEffect.Type>(() => {
      restoreScroll(key, element as HTMLElement)
      const remember = () => saveScroll(key, element as HTMLElement)
      element.addEventListener("scroll", remember, { passive: true })
      return () => element.removeEventListener("scroll", remember)
    }),
})

// CONTROLS

export function tooltipOf(model: Model, id: string): Tooltip.Model {
  return model.tooltips[id] ?? Tooltip.init({ id: `viewer-${id}`, delayDuration: 0 })
}

/**
 * A header control: an icon, named by its tooltip, lit when it's the active
 * choice. Dimmed and inert when disabled, but still named by its tooltip:
 * `aria-disabled`, not `disabled`.
 */
export function viewerIconButton(
  model: Model,
  options: { id: string; label: string; active?: boolean; disabled?: boolean; onClick: Message },
  icon: Html,
  h: H,
): Html {
  const { id, label, active = false, disabled = false } = options
  return h.submodel({
    slotId: `viewer-tooltip-${id}`,
    model: tooltipOf(model, id),
    view: Tooltip.view,
    viewInputs: {
      content: () => [label],
      toView: ({ trigger, portal }) => h.button([
        ...trigger,
        h.Type("button"),
        h.AriaLabel(label),
        ...(active ? [h.AriaPressed("true")] : []),
        ...(disabled ? [h.AriaDisabled(true)] : [h.OnClick(options.onClick)]),
        h.Class(cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
          active && "bg-muted text-foreground",
          disabled && "cursor-default opacity-40 hover:bg-transparent hover:text-muted-foreground",
        )),
      ], [icon, portal]),
    },
    toParentMessage: (message: Tooltip.Message) => Message.GotTooltipMessage({ id, message }),
  })
}

/** A hairline between groups of header controls. */
export function viewerDivider(h: H): Html {
  return h.span([h.AriaHidden(true), h.Class("h-4 w-px shrink-0 bg-border")], [])
}

/**
 * Two or three mutually exclusive views of one thing ("Preview" / "Original"),
 * as text in the header.
 */
export function viewerToggle(
  value: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  onChange: (value: string) => Message,
  h: H,
): Html {
  return h.div([h.Role("radiogroup"), h.Class("flex h-7 shrink-0 items-center rounded-[8px] border border-border p-0.5")], options.map((option) =>
    h.keyed("button")(option.value, [
      h.Type("button"),
      h.Role("radio"),
      h.AriaChecked(option.value === value),
      h.OnClick(onChange(option.value)),
      h.Class(cn(
        "h-full rounded-[5px] px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        option.value === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
      )),
    ], [option.label])))
}

/**
 * The bodies a ViewerToggle switches between. Each mounts the first time it's
 * shown and then stays; the one not showing is `content-visibility: hidden`.
 */
export function viewerPanes(
  model: Model,
  cardKey: string,
  value: string,
  panes: ReadonlyArray<{ key: string; render: () => Html }>,
  h: H,
): Html {
  const shown = new Set(model.card?.key === cardKey ? model.panes[cardKey] ?? [] : [])
  shown.add(value)
  return h.div([h.Class("relative h-full")], panes.filter((pane) => shown.has(pane.key)).map((pane) => {
    const active = pane.key === value
    return h.keyed("div")(pane.key, [
      ...(active ? [] : [h.Inert(true), h.AriaHidden(true)]),
      h.Class(cn("absolute inset-0 overflow-auto", !active && "pointer-events-none [content-visibility:hidden]")),
    ], [pane.render()])
  }))
}

// THE CARD

export function viewerSurface(model: Model, context: LayerContext, config: SurfaceConfig, h: H): Html {
  const { placement, floor } = context
  const held = model.card?.key === config.cardKey ? model.card : null
  const cardEnters = held ? held.cardEnters : context.motion.cardEnters
  const bodyEnters = held ? held.bodyEnters : context.motion.bodyEnters
  const back = config.leading ?? (floor?.hasBack
    ? viewerIconButton(model, { id: "back", label: `${floor.backLabel} (Esc)`, onClick: Message.ClickedBack() }, ArrowLeft({}, h), h)
    : null)
  const docked = placement !== null && !placement.expanded
  const navigation = config.navigation && config.navigation.count > 1 ? config.navigation : null
  const center = config.center ?? null
  const subtitle = config.subtitle || null

  const header = h.header([
    h.Class(cn(
      "h-[49px] shrink-0 items-center gap-2 border-b border-border pl-4 pr-2",
      center ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "flex",
    )),
  ], [
    h.div([h.Class(cn("flex min-w-0 items-center gap-2", !center && "flex-1"))], [
      back ? h.div([h.Class("-ml-2 flex shrink-0 items-center")], [back]) : null,
      config.icon ? h.span([h.Class("flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4")], [config.icon]) : null,
      h.div([h.Class("flex min-w-0 flex-1 items-baseline gap-2")], [
        h.span([h.Class(cn("min-w-0 truncate text-sm font-medium text-foreground", subtitle ? "max-w-[60%] shrink-0" : "flex-1"))], [config.title]),
        subtitle ? h.span([h.Class("min-w-0 flex-1 truncate text-xs text-muted-foreground")], [subtitle]) : null,
      ]),
    ]),
    center ? h.div([h.Class("flex items-center")], [center]) : null,
    h.div([h.Class("flex min-w-0 shrink-0 items-center justify-end gap-2")], [
      config.toolbar ? h.div([h.Class("flex shrink-0 items-center gap-1")], config.toolbar) : null,
      ...(navigation ? [
        viewerDivider(h),
        h.span([h.Class("shrink-0 px-1 text-xs tabular-nums text-muted-foreground")], [`${navigation.index + 1} of ${navigation.count}`]),
        viewerIconButton(model, {
          id: "previous",
          label: navigation.previousLabel ?? "Previous (k)",
          disabled: navigation.hasPrevious === false,
          onClick: Message.ClickedNavigation({ direction: "previous" }),
        }, ChevronUp({}, h), h),
        viewerIconButton(model, {
          id: "next",
          label: navigation.nextLabel ?? "Next (j)",
          disabled: navigation.hasNext === false,
          onClick: Message.ClickedNavigation({ direction: "next" }),
        }, ChevronDown({}, h), h),
      ] : []),
      viewerDivider(h),
      placement
        ? viewerIconButton(model, {
          id: "expand",
          label: placement.expanded ? "Show chat" : "Expand",
          onClick: Message.ClickedToggleExpanded(),
        }, placement.expanded ? Minimize2({}, h) : Maximize2({}, h), h)
        : null,
      // Esc is Back while there is one, so Close names the key only where it is what the key does.
      viewerIconButton(model, {
        id: "close",
        label: back && floor ? "Close" : "Close (Esc)",
        onClick: floor ? Message.ClickedShut() : Message.ClickedClose(),
      }, X({}, h), h),
    ]),
  ])

  const body = h.div([
    h.Class(cn("min-h-0 flex-1 overflow-auto", bodyEnters && VIEWER_BODY_ENTER_CLASS, config.bodyClassName)),
    ...(config.scrollMemoryKey ? [h.OnMount(ScrollMemory({ key: config.scrollMemoryKey }))] : []),
  ], config.body)

  return h.keyed("div")(`viewer-card:${config.cardKey}`, [
    h.Tabindex(-1),
    h.Role("region"),
    h.AriaLabel(config.label),
    h.Attribute(FOCUS_FALLBACK_IGNORE_ATTRIBUTE, ""),
    ...(docked ? [] : [h.DataAttribute("state", "open")]),
    h.DataAttribute("viewer-surface", ""),
    ...(placement ? [h.DataAttribute("bleed", "")] : []),
    ...(config.fieldsKeepEscape ? [h.Attribute(VIEWER_FIELDS_KEEP_ESCAPE_ATTRIBUTE, "")] : []),
    h.Class(viewerCardClass(placement !== null, cardEnters)),
    h.OnMount(ViewerSurfaceMount({ key: config.cardKey, cardEnters, bodyEnters, quietFocus: config.quietFocus ?? false })),
  ], [
    header,
    body,
    navigation
      ? h.keyed("span")(`viewer-nav:${navigation.count}:${navigation.hasNext !== false}:${navigation.hasPrevious !== false}:${docked}`, [
        h.Hidden(true),
        h.OnMount(ViewerNavigationKeys({ count: navigation.count, hasNext: navigation.hasNext !== false, hasPrevious: navigation.hasPrevious !== false, docked })),
      ], [])
      : null,
  ])
}
