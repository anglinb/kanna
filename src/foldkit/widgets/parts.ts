import { Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import type { Child } from "../ui/attributes"
import { buttonClass } from "../ui/button"
import { ArrowUpRight, ChevronDown, ChevronRight, Ellipsis } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"

// widgets/WidgetCard.tsx and widgets/parts.tsx: the parts every widget body
// is built from, as view functions generic over the host's Message (the
// widget column and the /workflows gallery both draw them). A card is a
// header (widgetSection) over, optionally, a Strip, then a List or Static,
// then a Footer. See parts.tsx for the grammar; the comments that still
// explain the markup are carried over.
//
// What React held in component state here is either the host's (a
// disclosure's open state, from the right sidebar store) or not kept: a
// slot's enter/exit phases (WidgetPresence) and a status's cross-fade
// (SwapIn) are transitions a capture never sees, so a slot is shown or not
// and a status is its current key.

export type { Child }

// EVENTS THE ATTRIBUTES DON'T CARRY

export const PartsMessage = defineMessageUnion({
  /** A row's kebab: where `openContextMenuFromButton` opens the menu, under its middle. */
  PressedRowKebab: { x: Schema.Number, y: Schema.Number },
  CompletedStopPropagation: {},
})
export type PartsMessage = typeof PartsMessage.Type

/**
 * On a row's kebab: `openContextMenuFromButton`. The click is stopped (the
 * row under it doesn't activate) and reported with the point under the
 * button's middle, where the menu opens.
 */
export const RowKebab = Mount.defineStream("WidgetRowKebab", {
  messages: [PartsMessage.PressedRowKebab],
  execute: ({ element }) => domStream<typeof PartsMessage.PressedRowKebab.Type>((emit) => {
    const click = (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      emit(PartsMessage.PressedRowKebab({ x: Math.trunc(rect.left + rect.width / 2), y: Math.trunc(rect.bottom) }))
    }
    element.addEventListener("click", click as EventListener)
    return () => element.removeEventListener("click", click as EventListener)
  }),
})

/**
 * React's `event.stopPropagation()` in a control's onClick, inside a row that
 * activates on a click (the commit checkbox, a checks rollup). The control's
 * own click handler still runs.
 */
export const StopClickPropagation = Mount.define("WidgetStopClickPropagation", {
  messages: [PartsMessage.CompletedStopPropagation],
  execute: ({ element }) => Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stop = (event: Event) => event.stopPropagation()
        element.addEventListener("click", stop)
        return stop
      }),
      (stop) => Effect.sync(() => element.removeEventListener("click", stop)),
    )
    return PartsMessage.CompletedStopPropagation()
  }),
})

/**
 * React's `event.stopPropagation()` on Escape in a field's onKeyDown: the
 * page listens for Escape on window, and this Escape is the field's.
 */
export const StopEscapePropagation = Mount.define("WidgetStopEscapePropagation", {
  messages: [PartsMessage.CompletedStopPropagation],
  execute: ({ element }) => Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const stop = (event: Event) => {
          if ((event as KeyboardEvent).key === "Escape") event.stopPropagation()
        }
        element.addEventListener("keydown", stop)
        return stop
      }),
      (stop) => Effect.sync(() => element.removeEventListener("keydown", stop)),
    )
    return PartsMessage.CompletedStopPropagation()
  }),
})

/** React's `autoFocus`: the field takes focus as it mounts. */
export const FocusOnMount = Mount.define("WidgetFocusOnMount", {
  messages: [PartsMessage.CompletedStopPropagation],
  execute: ({ element }) => Effect.sync(() => {
    ;(element as HTMLElement).focus()
    return PartsMessage.CompletedStopPropagation()
  }),
})

// WIDGETCARD.TSX

/** One header grammar for every widget: see WidgetSection. */
export interface WidgetSectionOptions<M> {
  /** Omit when the title brings its own glyph. */
  icon?: Html
  title: ReadonlyArray<Child>
  /** Trailing muted count next to the title, e.g. "3" or "2 of 5". */
  count?: ReadonlyArray<Child> | string | number | null
  /** Controls on the right of the header. */
  actions?: ReadonlyArray<Child> | null
  expanded?: boolean
  /** Makes the header a disclosure (chevron, rotates when open). */
  onToggle?: M
  /** The body. Omit for a header-only section. */
  body?: ReadonlyArray<Child> | null
  /** What the body shows while the disclosure is closed (the Branch card's PR and changes). */
  collapsedBody?: ReadonlyArray<Child> | null
  /** Off when the body draws its own dividers. */
  bodyDivider?: boolean
  /** Always visible below the body, even while a disclosure is collapsed. */
  footer?: Html | null
  /** Keyed by this among its card's sections. */
  key?: string
}

const hasContent = (children: ReadonlyArray<Child> | null | undefined) =>
  children !== null && children !== undefined && children.some((child) => child !== null && child !== "")

/** A header, its body and footer, without the card around them. */
export function widgetSection<M>(options: WidgetSectionOptions<M>, h: HtmlBuilder<M>): Html {
  const { icon, title, count, actions, expanded, onToggle } = options
  const open = onToggle === undefined || Boolean(expanded)
  const body = open ? options.body : options.collapsedBody
  const bodyDivider = options.bodyDivider ?? true
  const countChildren = count === undefined || count === null ? null : typeof count === "string" || typeof count === "number" ? [String(count)] : count
  const heading: ReadonlyArray<Child> = [
    icon ? h.span([h.Class("flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4")], [icon]) : null,
    h.span([h.Class("flex min-w-0 items-baseline gap-1.5")], [
      h.span([h.Class("min-w-0 truncate text-section-title")], title),
      countChildren ? h.span([h.Class("shrink-0 tabular-nums text-muted-foreground")], countChildren) : null,
    ]),
    // Rotates on every toggle, so short; the body itself opens instantly.
    onToggle !== undefined
      ? ChevronRight({ class: cn("-ml-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy", expanded && "rotate-90") }, h)
      : null,
  ]
  const children: ReadonlyArray<Child> = [
    h.header([h.Class("flex h-10 items-center gap-2 pl-3 pr-2 text-sm")], [
      onToggle !== undefined
        ? h.button([
          h.Type("button"),
          h.AriaExpanded(Boolean(expanded)),
          h.OnClick(onToggle),
          h.Class("-ml-1.5 flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"),
        ], heading)
        : h.div([h.Class("flex min-w-0 flex-1 items-center gap-2")], heading),
      hasContent(actions) ? h.div([h.Class("flex shrink-0 items-center gap-1")], actions!) : null,
    ]),
    // Uncapped: a widget is as tall as its content and the column scrolls.
    hasContent(body)
      ? h.keyed("div")(open ? "open" : "closed", [...(bodyDivider ? [h.Class("border-t border-border")] : [])], body!)
      : null,
    options.footer ? h.div([h.Class("border-t border-border")], [options.footer]) : null,
  ]
  return options.key !== undefined ? h.keyed("div")(options.key, [], children) : h.div([], children)
}

/**
 * The card surface that holds a widget's sections, divided from each other.
 * Lifted off whatever is under it while the column is a slideover.
 */
export function widgetGroup<M>(options: { class?: string; attributes?: ReadonlyArray<Attribute<M>>; key?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  const attributes = [
    h.Class(cn("divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background dark:bg-card mac-app:rounded-[calc(var(--mac-window-radius)-8px)] transition-shadow duration-200 ease-out group-data-[slideover]/widgets:shadow-md", options.class)),
    ...(options.attributes ?? []),
  ]
  // Keyed, a new key is a new card (React's `key` on the widget: the gallery's live run each loop).
  return options.key !== undefined ? h.keyed("section")(options.key, attributes, children) : h.section(attributes, children)
}

/** A one-section widget: the common case. */
export function widgetCard<M>(options: WidgetSectionOptions<M> & { class?: string }, h: HtmlBuilder<M>): Html {
  return widgetGroup({ class: options.class }, [widgetSection(options, h)], h)
}

const SLOT_SHOWN = ["grid-rows-[1fr]", "opacity-100", "duration-200"]
const SLOT_ENTERING = ["grid-rows-[0fr]", "opacity-0", "duration-150"]
/** Hosts whose first render is going on now: the slots in it were there all along. */
const hostsInFirstRender = new WeakSet<Element>()
const hostsSeen = new WeakSet<Element>()

/**
 * WidgetPresence's entrance: a slot that appears after its host's first
 * render grows in (rows 0fr → 1fr, with opacity). The collapsed style is
 * committed first, as React's entering phase was, then the resting one, so
 * the transition runs between them. A slot there from the host's first
 * render shows at once: opening the column is not a change to announce.
 */
export const PresenceEnter = Mount.define("WidgetPresenceEnter", {
  messages: [PartsMessage.CompletedStopPropagation],
  execute: ({ element }) => Effect.sync(() => {
    const host = element.closest("[data-widgets-stack]") ?? element.parentElement
    if (host && !hostsSeen.has(host)) {
      hostsSeen.add(host)
      hostsInFirstRender.add(host)
      setTimeout(() => hostsInFirstRender.delete(host), 0)
    }
    if (host && !hostsInFirstRender.has(host)) {
      element.classList.remove(...SLOT_SHOWN)
      element.classList.add(...SLOT_ENTERING)
      element.getBoundingClientRect()
      element.classList.remove(...SLOT_ENTERING)
      element.classList.add(...SLOT_SHOWN)
    }
    return PartsMessage.CompletedStopPropagation()
  }),
})

/**
 * One slot in the column (WidgetPresence): it grows in when it appears after
 * the column's first render (`PresenceEnter`) and is gone at once when it
 * leaves. The slot also owns the column's spacing (pt-2 inside the
 * collapsing part, 1px for the first), so a card's gap goes with it.
 */
export function widgetPresence<M>(
  options: { show: boolean; spaced?: boolean; key: string; toParts: (message: PartsMessage) => M },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html {
  if (!options.show) return null
  const spaced = options.spaced ?? true
  return h.keyed("div")(`slot-${options.key}`, [
    h.Class("group/widget-slot grid transition-[grid-template-rows,opacity] ease-snappy motion-reduce:transition-opacity grid-rows-[1fr] opacity-100 duration-200"),
    h.OnMount(Mount.mapMessage(PresenceEnter(), options.toParts)),
  ], [
    h.div([h.Class("min-h-0 overflow-hidden")], [
      // The top card sits right under the navbar: 1px, not a gap.
      h.div(spaced ? [h.Class("pt-2 group-first/widget-slot:pt-[1px]")] : [], children),
    ]),
  ])
}

/** A status that changes in place (spinner → check). Keyed by its state, as React remounted it. */
export function swapIn<M>(options: { swapKey: string; class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.keyed("span")(`swap-${options.swapKey}`, [h.Class(cn("inline-flex items-center", options.class))], children)
}

/**
 * Whether a disclosure starts open: yes when it holds a few rows, no when it
 * holds many.
 */
export function defaultWidgetExpanded(rowCount: number) {
  return rowCount > 0 && rowCount <= 3
}

// PARTS.TSX

/**
 * The row highlight, the outline button's hover: a muted fill inside a
 * border. Rows carry a transparent border at rest so lighting one shifts
 * nothing. Instant, with no transition.
 */
export const ROW_HIGHLIGHT_CLASS = "border-border bg-muted"
// Also while the row's hover card is up, and while its menu is open (Radix
// marks the trigger `data-state="open"`). On touch, it lights on touch-down.
export const ROW_HOVER_CLASS = "hover:border-border hover:bg-muted data-[hover-card-open]:border-border data-[hover-card-open]:bg-muted data-[state=open]:border-border data-[state=open]:bg-muted [@media(hover:none)]:active:border-border [@media(hover:none)]:active:bg-muted"

/** A row's box, before any highlight. Relative: the kebab is laid over its trailing slot. */
const ROW_BASE_CLASS = "relative flex w-full min-w-0 items-start gap-2 rounded-lg border border-transparent px-[5px] py-1.5 text-left text-sm"

/** In at 120ms, out at once: what leaves shrinks toward the right edge it is anchored to. */
const ROW_SWAP_CLASS = "origin-right transition-[opacity,scale,filter] duration-0 ease-snappy row-revealed:duration-120"
const ROW_TRAILING_OUT_CLASS = cn(ROW_SWAP_CLASS, "row-revealed:opacity-0 motion-safe:row-revealed:scale-92 motion-safe:row-revealed:blur-[1px]")
const ROW_KEBAB_IN_CLASS = cn(ROW_SWAP_CLASS, "opacity-0 motion-safe:scale-92 motion-safe:blur-[1px] row-revealed:opacity-100 row-revealed:scale-100 row-revealed:blur-none")
/** A row with nothing trailing: the title's end fades out under the kebab rather than reflowing around it. */
const ROW_TITLE_OUT_CLASS = "row-revealed:[mask-image:linear-gradient(to_left,transparent_18px,black_34px)]"

/** The 16px icon column, one text line tall so it centers on a row's first line. */
export function widgetIconColumn<M>(options: { class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.span([h.Class(cn("flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5 [&>span>svg]:size-3.5", options.class))], children)
}

/**
 * A 36px bar under the header, divided from what follows: a search, the
 * Quick Actions input, or controls that act on the whole list. With `field`,
 * a filled field inset in the card rather than a bar across it.
 */
export function widgetStrip<M>(
  options: {
    leading?: Child
    trailing?: ReadonlyArray<Child> | null
    /** Makes the strip a form (Quick Actions' add): its attributes (submit, focus). */
    form?: ReadonlyArray<Attribute<M>>
    field?: boolean
  },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html {
  const content: ReadonlyArray<Child> = [
    h.span([h.Class("flex w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5")], options.leading ? [options.leading] : []),
    h.div([h.Class("flex min-w-0 flex-1 items-center gap-2")], children),
    hasContent(options.trailing) ? h.div([h.Class("flex shrink-0 items-center gap-1")], options.trailing!) : null,
  ]
  // A bar is divided from what follows it, but not from the card's own edge
  // when it is all the body holds.
  const className = options.field
    ? "mx-1.5 mt-1.5 flex h-8 items-center gap-2 rounded-lg bg-[hsl(210_20%_95.5%)] dark:bg-[hsl(223_4%_21.5%)] pl-1.5 pr-0.5 last:mb-1.5"
    : "flex h-9 items-center gap-2 border-border pl-3 pr-2 not-last:border-b"
  return options.form
    ? h.form([...options.form, h.Class(className)], content)
    : h.div([h.Class(className)], content)
}

/** The input a Strip usually holds: borderless, it is the strip. */
export const WIDGET_STRIP_INPUT_CLASS = "h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"

/** Rows, 6px in from the card's edges, a 1px gap apart. */
export function widgetList<M>(options: { class?: string; attributes?: ReadonlyArray<Attribute<M>> }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.div([h.Class(cn("flex flex-col gap-px p-1.5", options.class)), ...(options.attributes ?? [])], children)
}

/**
 * A group's header inside a List ("Recent", "Pull requests"), set like the
 * left sidebar's section headers. With `onToggle` the whole header folds its
 * group.
 */
export function widgetListLabel<M>(options: { label: string; count?: number; expanded?: boolean; onToggle?: M; key?: string }, h: HtmlBuilder<M>): Html {
  const expanded = options.expanded ?? true
  const content: ReadonlyArray<Child> = [
    h.span([h.Class("min-w-0 truncate text-sm text-slate-500 dark:text-slate-400")], [options.label]),
    options.count !== undefined ? h.span([h.Class("shrink-0 text-sm tabular-nums text-slate-400 dark:text-slate-500")], [String(options.count)]) : null,
    options.onToggle !== undefined
      ? ChevronRight({ class: cn("size-3.5 shrink-0 translate-y-[1px] text-slate-400 transition-transform duration-200", expanded && "rotate-90") }, h)
      : null,
  ]
  const className = "flex w-full min-w-0 items-center gap-1 px-1.5 pb-1 pt-2.5 text-left first:pt-1"
  const key = options.key ?? `label-${options.label}`
  if (options.onToggle === undefined) return h.keyed("div")(key, [h.Class(className)], content)
  return h.keyed("button")(key, [
    h.Type("button"),
    h.AriaExpanded(expanded),
    h.OnClick(options.onToggle),
    // Out of the tab order in a combobox's list: the search keeps focus.
    h.Tabindex(-1),
    h.Class(cn(className, "cursor-pointer select-none")),
  ], content)
}

/** What a row's kebab is laid over: the idle glyph, else the meta's first line, else the end of the title. */
export function widgetRowTrailing(options: { hasMenu: boolean; meta?: unknown; menuIdle?: unknown }): "idle" | "meta" | "title" | null {
  if (!options.hasMenu) return null
  if (options.menuIdle) return "idle"
  if (options.meta) return "meta"
  return "title"
}

export interface WidgetRowMenu<M> {
  /** The right click (or long press) that opens the row's menu: the host's trigger attributes. */
  trigger: ReadonlyArray<Attribute<M>>
  /** The kebab's click, under its middle (`RowKebab`, mapped into the host's Message). */
  onKebab: (point: { x: number; y: number }) => M
  /** The kebab's label. Default "More actions". */
  label?: string
}

export interface WidgetRowOptions<M> {
  /** Keyed by this in its list. */
  key: string
  icon?: Child
  title: ReadonlyArray<Child> | string
  subtitle?: ReadonlyArray<Child> | string | null
  meta?: ReadonlyArray<Child> | string | null
  subMeta?: Child
  menu?: WidgetRowMenu<M> | null
  menuIdle?: Child
  /** Makes the row pressable (Enter and Space too). */
  onActivate?: M
  /**
   * Makes the row pressable with handlers of the caller's own (a quick
   * action's row, which the page runs): the row is interactive, and these go
   * on it instead of `onActivate`'s click and keys.
   */
  activation?: ReadonlyArray<Attribute<M> | ChildAttribute>
  highlightClassName?: string
  active?: boolean
  disabled?: boolean
  muted?: boolean
  id?: string
  rowKey?: string
  role?: string
  tabIndex?: number
  tooltip?: string
  ariaLabel?: string
  ariaSelected?: boolean
  ariaBusy?: boolean
  class?: string
  /** Attributes after the rest (the commit row's checkbox Mount and so on go on children). */
  attributes?: ReadonlyArray<Attribute<M>>
}

const asChildren = (value: ReadonlyArray<Child> | string): ReadonlyArray<Child> => (typeof value === "string" ? [value] : value)
const filled = (value: ReadonlyArray<Child> | string | null | undefined) =>
  value !== null && value !== undefined && (typeof value === "string" ? value !== "" : hasContent(value))

/**
 * The one row in the column: icon column, title over an optional subtitle,
 * meta, then the kebab. 34px with one line, 50px with two. A div rather
 * than a button: a row can hold other controls.
 */
export function widgetRow<M>(options: WidgetRowOptions<M>, h: HtmlBuilder<M>): Html {
  const { menu, onActivate } = options
  const disabled = options.disabled ?? false
  const active = options.active ?? false
  const muted = options.muted ?? false
  const activatable = onActivate !== undefined || options.activation !== undefined
  const interactive = activatable && !disabled
  const hasMenu = Boolean(menu)
  const hasMeta = filled(options.meta)
  const trailing = widgetRowTrailing({ hasMenu, meta: hasMeta, menuIdle: options.menuIdle })
  const role = options.role ?? (activatable ? "button" : undefined)
  const tabIndex = options.tabIndex ?? (activatable ? 0 : undefined)
  return h.keyed("div")(options.key, [
    ...(options.id !== undefined ? [h.Id(options.id)] : []),
    ...(options.rowKey !== undefined ? [h.DataAttribute("row-key", options.rowKey)] : []),
    ...(role !== undefined ? [h.Role(role)] : []),
    ...(tabIndex !== undefined ? [h.Tabindex(tabIndex)] : []),
    ...(activatable && disabled ? [h.AriaDisabled(true)] : []),
    ...(options.tooltip !== undefined ? [h.Title(options.tooltip)] : []),
    ...(active ? [h.DataAttribute("active", "true")] : []),
    ...(interactive && onActivate !== undefined ? [h.OnClick(onActivate)] : []),
    ...(interactive && onActivate !== undefined
      ? [h.OnKeyDownSelfPreventDefault((key) => (key === "Enter" || key === " " ? Option.some(onActivate) : Option.none()))]
      : []),
    ...(interactive && options.activation !== undefined ? options.activation : []),
    h.Class(cn(
      ROW_BASE_CLASS,
      "group/row outline-none focus-visible:ring-2 focus-visible:ring-ring",
      interactive && "cursor-pointer",
      // A long-press opens the menu on touch; it shouldn't select text too.
      hasMenu && "[@media(hover:none)]:select-none",
      disabled && "opacity-60",
      muted && "text-muted-foreground",
      options.highlightClassName ?? (active ? ROW_HIGHLIGHT_CLASS : interactive || hasMenu ? ROW_HOVER_CLASS : undefined),
      options.class,
    )),
    ...(options.ariaLabel !== undefined ? [h.AriaLabel(options.ariaLabel)] : []),
    ...(options.ariaSelected !== undefined ? [h.AriaSelected(options.ariaSelected)] : []),
    ...(options.ariaBusy !== undefined ? [h.AriaBusy(options.ariaBusy)] : []),
    ...(menu ? menu.trigger : []),
    ...(options.attributes ?? []),
  ], [
    widgetIconColumn({}, options.icon !== undefined ? [options.icon] : [], h),
    h.div([h.Class("min-w-0 flex-1")], [
      h.div([
        ...(trailing === "title" ? [h.DataAttribute("row-trailing", "")] : []),
        h.Class(cn(
          "truncate leading-5",
          muted ? "text-muted-foreground group-hover/row:text-foreground group-data-[hover-card-open]/row:text-foreground" : "text-foreground",
          trailing === "title" && ROW_TITLE_OUT_CLASS,
        )),
      ], asChildren(options.title)),
      filled(options.subtitle) ? h.div([h.Class("truncate text-xs leading-4 text-muted-foreground")], asChildren(options.subtitle!)) : null,
    ]),
    hasMeta || options.subMeta
      ? h.div([h.Class("flex shrink-0 flex-col items-end text-xs tabular-nums text-muted-foreground")], [
        h.div([
          ...(trailing === "meta" ? [h.DataAttribute("row-trailing", "")] : []),
          h.Class(cn("flex h-5 items-center gap-1.5", trailing === "meta" && ROW_TRAILING_OUT_CLASS)),
        ], hasMeta ? asChildren(options.meta!) : []),
        options.subMeta ? h.div([h.Class("flex h-4 items-center gap-1.5")], [options.subMeta]) : null,
      ])
      : null,
    options.menuIdle
      ? h.span([
        ...(hasMenu ? [h.AriaHidden(true)] : []),
        ...(trailing === "idle" ? [h.DataAttribute("row-trailing", "")] : []),
        h.Class(cn("flex h-5 w-4 shrink-0 items-center justify-center", trailing === "idle" && ROW_TRAILING_OUT_CLASS)),
      ], [options.menuIdle])
      : null,
    menu
      // Over the content box's top-right corner: the first line's trailing end.
      ? h.span([h.Class("absolute right-[5px] top-1.5 flex h-5 items-center")], [widgetRowMenuButton(menu, h)])
      : null,
  ])
}

/**
 * The kebab over a row's trailing end. It opens the row's context menu; it
 * shows while the row is revealed, and Tab reaches it. Not on devices that
 * can't hover.
 */
export function widgetRowMenuButton<M>(menu: WidgetRowMenu<M>, h: HtmlBuilder<M>): Html {
  const label = menu.label ?? "More actions"
  return h.button([
    h.Class(buttonClass({
      variant: "ghost",
      size: "none",
      class: cn(
        "!h-auto !w-auto shrink-0 border-border/0 text-muted-foreground hover:!border-border/0 hover:!bg-transparent hover:text-foreground active:scale-95 [@media(hover:none)]:hidden",
        ROW_KEBAB_IN_CLASS,
      ),
    })),
    h.Type("button"),
    h.AriaLabel(label),
    h.Title(label),
    h.DataAttribute("row-menu", ""),
    h.OnMount(Mount.mapMessage(RowKebab(), (message) => menu.onKebab({ x: message.x, y: message.y }))),
  ], [Ellipsis({ class: "w-4" }, h)])
}

/** Rows revealed by a "Show more" fade in (150ms, opacity only). */
export const WIDGET_ROW_REVEAL_CLASS = "transition-opacity duration-150 ease-snappy starting:opacity-0"

/**
 * The end of a list that shows only part of itself: "Show 4 more ⌄", then
 * "Show less ⌃"; with `href`, "All 38 on GitHub ↗".
 */
export function widgetMoreRow<M>(
  options: {
    count: number
    total?: number
    href?: string
    shown?: boolean
    /** The click: show, hide or open. */
    onClick?: M
    detail?: string
    suppressHover?: boolean
    tabIndex?: number
    key?: string
  },
  h: HtmlBuilder<M>,
): Html {
  const shown = options.shown ?? false
  const label = options.href
    ? `All ${(options.total ?? options.count).toLocaleString()} on GitHub`
    : shown ? "Show less" : `Show ${options.count.toLocaleString()} more`
  return h.keyed("button")(options.key ?? "more", [
    h.Type("button"),
    ...(options.tabIndex !== undefined ? [h.Tabindex(options.tabIndex)] : []),
    ...(options.href ? [] : [h.AriaExpanded(shown)]),
    ...(options.onClick !== undefined ? [h.OnClick(options.onClick)] : []),
    h.Class(cn(
      "flex h-7 w-full items-center gap-1 rounded-lg pl-[30px] pr-[5px] text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
      !options.suppressHover && "hover:text-foreground",
    )),
  ], [
    swapIn({ swapKey: label }, [label], h),
    options.detail && !shown ? h.span([h.Class("text-muted-foreground/70")], [`· ${options.detail}`]) : null,
    options.href
      ? ArrowUpRight({ class: "size-3 shrink-0" }, h)
      : ChevronDown({ class: cn("size-3 shrink-0 transition-transform duration-200 ease-snappy", shown && "rotate-180") }, h),
  ])
}

/** What you only read: usage bars, an empty state. 12px in, like the header. */
export function widgetStatic<M>(options: { class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.div([h.Class(cn("px-3 py-3", options.class))], children)
}

/** Actions under a card's body: the commit row, Merge / PR, Init Git. */
export function widgetFooter<M>(options: { above?: Html | null }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.div([], [
    options.above ? h.div([h.Class("border-b border-border")], [options.above]) : null,
    h.div([h.Class("flex h-10 min-w-0 items-stretch divide-x divide-border")], children),
  ])
}

/** A Footer's main button (an outline Button, unframed): the row's width and height. */
export const WIDGET_FOOTER_BUTTON_CLASS = "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent"
/** A Footer's square button, beside the main one. */
export const WIDGET_FOOTER_ICON_BUTTON_CLASS = "h-full w-10 shrink-0 rounded-none border-0 bg-transparent p-0"

/** Tiles in a List (Attachments' thumbnails). */
export function widgetTileGrid<M>(children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.div([h.Class("-m-[3px] grid grid-cols-[repeat(auto-fill,minmax(102px,1fr))]")], children)
}

/** One tile: the cell is the hit area, the inner box is what lights. */
export function widgetTile<M>(options: { key: string; onActivate: M; tooltip?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.keyed("button")(options.key, [
    h.Type("button"),
    ...(options.tooltip !== undefined ? [h.Title(options.tooltip)] : []),
    h.OnClick(options.onActivate),
    h.Class("group/tile p-[3px]"),
  ], [
    h.span([h.Class("block aspect-square overflow-hidden rounded-lg border border-border bg-muted transition-[scale] duration-150 ease-snappy group-hover/tile:border-foreground/25 group-active/tile:scale-[0.97]")], children),
  ])
}

/** A failure to read, at the top of a List or Static. */
export function widgetError<M>(text: string, h: HtmlBuilder<M>): Html {
  return h.p([h.Class("mb-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive")], [text])
}
