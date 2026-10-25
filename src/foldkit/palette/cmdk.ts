import { Effect, Option } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { afterCommit } from "foldkit/render"
import { cn } from "../../client/lib/utils"
import type { Child } from "../ui/attributes"

/**
 * cmdk 1.1.1 (`Command`, `Command.Input`, `Command.List`, `Command.Group`,
 * `Command.Item`, `Command.Empty`) as the app's ui/command.tsx styles it,
 * without React. The palette passes `shouldFilter={false}` and ranks rows
 * itself, so this is cmdk's markup, selection and keyboard model only:
 *
 *  - The list is data (`CmdkNode`s, in render order); keyboard navigation
 *    walks its enabled items as cmdk walks `[cmdk-item]:not([aria-disabled])`
 *    in the DOM.
 *  - The highlighted value is the caller's (cmdk's controlled `value`). A
 *    value no rendered item has falls to the first enabled item, as cmdk
 *    re-selects when the selected item unmounts or nothing is selected.
 *  - Arrow keys, Home/End, Ctrl+N/J/P/K, ⌘↑/⌘↓ (first/last) and ⌥↑/⌥↓
 *    (previous/next group) move it; Enter chooses it; the pointer moving
 *    over an item highlights it and a click chooses it.
 */

// IDS

export const ROOT_ID = "palette-cmdk"
export const LIST_ID = `${ROOT_ID}-list`
export const INPUT_ID = `${ROOT_ID}-input`
export const LABEL_ID = `${ROOT_ID}-label`

export const itemId = (value: string) => `${ROOT_ID}-item-${encodeURIComponent(value)}`
const headingId = (key: string) => `${ROOT_ID}-group-${encodeURIComponent(key)}`

// NODES

export interface CmdkItem {
  readonly kind: "item"
  readonly value: string
  readonly disabled?: boolean
  readonly className?: string
  readonly children: ReadonlyArray<Child>
}

/** Markup inside the list that isn't an item (a loading row, an error, a hint). */
export interface CmdkBlock {
  readonly kind: "block"
  readonly key: string
  readonly html: Html
}

export interface CmdkGroup {
  readonly kind: "group"
  readonly key: string
  readonly heading?: string
  readonly children: ReadonlyArray<CmdkItem | CmdkBlock>
}

export type CmdkNode = CmdkGroup | CmdkBlock

export function item(value: string, children: ReadonlyArray<Child>, options: { disabled?: boolean; className?: string } = {}): CmdkItem {
  return { kind: "item", value: value.trim(), children, ...options }
}

export function group(key: string, heading: string | undefined, children: ReadonlyArray<CmdkItem | CmdkBlock>): CmdkGroup {
  return { kind: "group", key, ...(heading ? { heading } : {}), children }
}

export function block(key: string, html: Html): CmdkBlock {
  return { kind: "block", key, html }
}

// SELECTION AND NAVIGATION

interface NavItem {
  value: string
  disabled: boolean
  /** Index of its group among the list's groups. */
  group: number
}

function navItems(nodes: ReadonlyArray<CmdkNode>): NavItem[] {
  const items: NavItem[] = []
  let groupIndex = 0
  for (const node of nodes) {
    if (node.kind !== "group") continue
    for (const child of node.children) {
      if (child.kind === "item") items.push({ value: child.value, disabled: Boolean(child.disabled), group: groupIndex })
    }
    groupIndex++
  }
  return items
}

/** Every item cmdk has registered: what `Command.Empty` counts. */
export function itemCount(nodes: ReadonlyArray<CmdkNode>): number {
  return navItems(nodes).length
}

/** All item values, in order. */
export function itemValues(nodes: ReadonlyArray<CmdkNode>): string[] {
  return navItems(nodes).map((entry) => entry.value)
}

/**
 * The highlighted item: `value` when an item has it, else the first enabled
 * one (cmdk selects the first item when nothing is selected or the selected
 * one leaves), else none.
 */
export function effectiveSelection(nodes: ReadonlyArray<CmdkNode>, value: string): string {
  const items = navItems(nodes)
  if (value && items.some((entry) => entry.value === value)) return value
  return items.find((entry) => !entry.disabled)?.value ?? ""
}

/** The item `value` names, if rendered. */
export function findItem(nodes: ReadonlyArray<CmdkNode>, value: string): CmdkItem | undefined {
  for (const node of nodes) {
    if (node.kind !== "group") continue
    for (const child of node.children) {
      if (child.kind === "item" && child.value === value) return child
    }
  }
  return undefined
}

export interface NavigationKeys {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

export type Navigation =
  | { kind: "select"; value: string }
  | { kind: "choose" }
  /** cmdk claimed the key (preventDefault) but nothing moved. */
  | { kind: "none" }

/**
 * cmdk's root keydown, after the caller's own handler: which value the key
 * moves to, Enter, or Option.none() when cmdk leaves the key alone.
 */
export function navigate(nodes: ReadonlyArray<CmdkNode>, selected: string, keys: NavigationKeys): Option.Option<Navigation> {
  const enabled = navItems(nodes).filter((entry) => !entry.disabled)
  const current = enabled.findIndex((entry) => entry.value === selected)
  const at = (index: number): Navigation => {
    const target = enabled[index]
    return target ? { kind: "select", value: target.value } : { kind: "none" }
  }
  // cmdk's Q(change): the item `change` away from the selected one. Not
  // looping; with nothing selected, down lands on the first.
  const step = (change: number): Navigation => at(current + change)
  // cmdk's re(change): the first enabled item of the next (or previous)
  // group that has one, else a plain step.
  const groupStep = (change: number): Navigation => {
    const from = enabled[current]
    if (!from) return step(change)
    const groups = [...new Set(enabled.map((entry) => entry.group))].sort((a, b) => a - b)
    const position = groups.indexOf(from.group)
    const nextGroup = groups[position + (change > 0 ? 1 : -1)]
    if (nextGroup === undefined) return step(change)
    return at(enabled.findIndex((entry) => entry.group === nextGroup))
  }
  const next = () => (keys.metaKey ? at(enabled.length - 1) : keys.altKey ? groupStep(1) : step(1))
  const previous = () => (keys.metaKey ? at(0) : keys.altKey ? groupStep(-1) : step(-1))
  switch (keys.key) {
    case "n":
    case "j":
      return keys.ctrlKey ? Option.some(next()) : Option.none()
    case "p":
    case "k":
      return keys.ctrlKey ? Option.some(previous()) : Option.none()
    case "ArrowDown":
      return Option.some(next())
    case "ArrowUp":
      return Option.some(previous())
    case "Home":
      return Option.some(at(0))
    case "End":
      return Option.some(at(enabled.length - 1))
    case "Enter":
      return Option.some({ kind: "choose" })
    default:
      return Option.none()
  }
}

// EFFECTS (Command bodies)

const selectedItemSelector = `#${LIST_ID} [cmdk-item][aria-selected="true"]`

/**
 * cmdk's `scrollSelectedIntoView` after a keyboard move: the selected item
 * into view, nearest edge, and its group's heading first when it is the
 * group's first item. cmdk also moves focus to the input when the root or
 * the input had it.
 */
export const scrollSelectedIntoView = Effect.gen(function* () {
  yield* afterCommit
  focusInputFromRoot()
  const selected = document.querySelector<HTMLElement>(selectedItemSelector)
  if (!selected) return
  if (selected.parentElement?.firstChild === selected) {
    selected.closest("[cmdk-group]")?.querySelector("[cmdk-group-heading]")?.scrollIntoView({ block: "nearest" })
  }
  selected.scrollIntoView({ block: "nearest" })
})

/** The focus half of cmdk's value change, for a pointer selection. */
export const focusInputAfterSelect = Effect.gen(function* () {
  yield* afterCommit
  focusInputFromRoot()
})

function focusInputFromRoot() {
  const active = document.activeElement
  if (active && (active.hasAttribute("cmdk-input") || active.hasAttribute("cmdk-root"))) {
    document.getElementById(INPUT_ID)?.focus()
  }
}

/**
 * The palette's scroll reset on open, page change and typing: the list to
 * the top now and again on the next frame, which wins over cmdk's own
 * scroll-into-view.
 */
export const resetListScroll = Effect.gen(function* () {
  yield* afterCommit
  const list = document.getElementById(LIST_ID)
  if (!list) return
  list.scrollTop = 0
  yield* Effect.callback<void>((resume) => {
    const frame = requestAnimationFrame(() => {
      const current = document.getElementById(LIST_ID)
      if (current) current.scrollTop = 0
      resume(Effect.void)
    })
    return Effect.sync(() => cancelAnimationFrame(frame))
  })
})

// VIEW

/** cmdk's visually-hidden label style. */
const SR_ONLY_STYLE: Record<string, string> = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: "0",
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  "white-space": "nowrap",
  "border-width": "0",
}

export interface ItemHandlers<Message> {
  /** The pointer moved over an enabled item (cmdk's onPointerMove). */
  hovered: (value: string) => Option.Option<Message>
  /** A click on an enabled item. */
  clicked: (value: string) => Message
}

function itemView<Message>(node: CmdkItem, selected: string, handlers: ItemHandlers<Message>, h: HtmlBuilder<Message>): Html {
  const disabled = Boolean(node.disabled)
  const isSelected = node.value !== "" && node.value === selected
  return h.keyed("div")(`item:${node.value}`, [
    h.Class(cn(
      "relative flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2 py-2 text-sm outline-none max-md:px-2.5 max-md:py-2.5 max-md:text-base",
      "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
      "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
      "[&_svg]:pointer-events-none [&_svg]:shrink-0",
      node.className,
    )),
    h.Id(itemId(node.value)),
    h.Attribute("cmdk-item", ""),
    h.Role("option"),
    h.AriaDisabled(disabled),
    h.AriaSelected(isSelected),
    h.DataAttribute("disabled", String(disabled)),
    h.DataAttribute("selected", String(isSelected)),
    h.DataAttribute("value", node.value),
    ...(disabled
      ? []
      : [
        h.OnPointerMove(() => handlers.hovered(node.value)),
        h.OnClick(handlers.clicked(node.value)),
      ]),
  ], node.children)
}

function groupView<Message>(node: CmdkGroup, selected: string, handlers: ItemHandlers<Message>, h: HtmlBuilder<Message>): Html {
  const children = node.children.map((child) => child.kind === "item"
    ? itemView(child, selected, handlers, h)
    : child.html)
  return h.keyed("div")(`group:${node.key}`, [
    h.Class(cn(
      "overflow-hidden text-foreground",
      "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
    )),
    h.Attribute("cmdk-group", ""),
    h.Role("presentation"),
    // cmdk sets the group's data-value to its heading, and to "undefined"
    // for a group with neither value nor heading.
    h.DataAttribute("value", node.heading ?? "undefined"),
  ], [
    ...(node.heading
      ? [h.div([h.Attribute("cmdk-group-heading", ""), h.AriaHidden(true), h.Id(headingId(node.key))], [node.heading])]
      : []),
    h.div([
      h.Attribute("cmdk-group-items", ""),
      h.Role("group"),
      ...(node.heading ? [h.AriaLabelledBy(headingId(node.key))] : []),
    ], children),
  ])
}

/** Blocks render in place, where React rendered them between groups. */
function topLevelView<Message>(node: CmdkNode, selected: string, handlers: ItemHandlers<Message>, h: HtmlBuilder<Message>): Html {
  return node.kind === "group" ? groupView(node, selected, handlers, h) : node.html
}

export interface ListOptions<Message> {
  nodes: ReadonlyArray<CmdkNode>
  selected: string
  /** `Command.Empty`'s content, rendered when no item is registered. Null to leave it out. */
  empty: string | null
  className?: string
  handlers: ItemHandlers<Message>
  /** Attributes for the list element (its Mount). */
  attributes?: ReadonlyArray<Attribute<Message>>
}

/** `<CommandList>` with its sizer, `<CommandEmpty>` first, then the nodes. */
export function listView<Message>(options: ListOptions<Message>, h: HtmlBuilder<Message>): Html {
  const selectedId = options.selected ? itemId(options.selected) : undefined
  const showEmpty = options.empty !== null && itemCount(options.nodes) === 0
  return h.div([
    h.Class(cn("max-h-[min(420px,55vh)] overflow-y-auto overflow-x-hidden overscroll-contain p-1.5", options.className)),
    h.Attribute("cmdk-list", ""),
    h.Role("listbox"),
    h.Tabindex(-1),
    ...(selectedId ? [h.AriaActiveDescendant(selectedId)] : []),
    h.AriaLabel("Suggestions"),
    h.Id(LIST_ID),
    ...(options.attributes ?? []),
  ], [
    h.div([h.Attribute("cmdk-list-sizer", "")], [
      ...(showEmpty
        ? [h.keyed("div")("empty", [
          h.Class("py-6 text-center text-sm text-muted-foreground"),
          h.Attribute("cmdk-empty", ""),
          h.Role("presentation"),
        ], [options.empty])]
        : []),
      ...options.nodes.map((node) => topLevelView(node, options.selected, options.handlers, h)),
    ]),
  ])
}

export interface InputOptions<Message> {
  value: string
  placeholder: string
  disabled: boolean
  selected: string
  onInput: (value: string) => Message
  /** Set on sub-pages: the leading icon becomes a Back button. */
  onBack: Message | null
  searchIcon: Html
  backIcon: Html
}

/** `<CommandInput>`: the search icon or Back button, then cmdk's combobox input. */
export function inputView<Message>(options: InputOptions<Message>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex items-center gap-2 border-b border-border px-3.5"), h.Attribute("cmdk-input-wrapper", "")], [
    options.onBack
      ? h.button([
        h.Type("button"),
        h.AriaLabel("Back"),
        h.OnClick(options.onBack),
        // -mx-1 cancels the p-1 hit-area padding on both sides so the button
        // occupies exactly the search icon's 16px: the input never shifts
        // between the root (search icon) and sub-pages (back button).
        h.Class("-mx-1 flex shrink-0 items-center rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"),
      ], [options.backIcon])
      : options.searchIcon,
    h.keyed("input")("input", [
      h.Class("flex h-12 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"),
      h.Placeholder(options.placeholder),
      h.Disabled(options.disabled),
      h.Attribute("cmdk-input", ""),
      h.Autocomplete("off"),
      h.Attribute("autocorrect", "off"),
      h.Spellcheck(false),
      h.AriaAutocomplete("list"),
      h.Role("combobox"),
      h.AriaExpanded(true),
      h.AriaControls(LIST_ID),
      h.AriaLabelledBy(LABEL_ID),
      ...(options.selected ? [h.AriaActiveDescendant(itemId(options.selected))] : []),
      h.Id(INPUT_ID),
      h.Type("text"),
      h.Value(options.value),
      h.OnInput(options.onInput),
    ]),
  ])
}

/** `<Command>`'s root and its hidden label. */
export function rootView<Message>(attributes: ReadonlyArray<Attribute<Message>>, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([
    h.Tabindex(-1),
    h.Class("flex h-full w-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground"),
    h.Attribute("cmdk-root", ""),
    h.Id(ROOT_ID),
    ...attributes,
  ], [
    h.label([h.Attribute("cmdk-label", ""), h.For(INPUT_ID), h.Id(LABEL_ID), h.Style(SR_ONLY_STYLE)]),
    ...children,
  ])
}
