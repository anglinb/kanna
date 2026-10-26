import { Duration, Effect, Number, Option, Schema } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { childAttributes, type ChildAttribute, type Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { cn } from "../../client/lib/utils"
import type { Child } from "./attributes"
import { focusElement, installFocusGuards, installFocusScope } from "./overlay/focus"
import { registerLayer } from "./overlay/layer"
import { hideOthers, lockScroll } from "./overlay/modal"
import { placePopper, pointReference, POPPER_WRAPPER_INITIAL_STYLE } from "./overlay/popper"
import { portalToBody } from "./overlay/portal"
import { waitForExitAnimation } from "./overlay/presence"
import { domStream } from "./overlay/stream"
import { createTypeahead, findNextMatch } from "./overlay/typeahead"

/**
 * `<ContextMenu>` / `<ContextMenuTrigger asChild>` / `<ContextMenuContent>` /
 * `<ContextMenuItem>` / `<ContextMenuSeparator>`
 * (src/client/components/ui/context-menu.tsx): Radix's modal context menu.
 *
 *  - A right click (or a 700ms touch press) on the trigger opens a
 *    `role="menu"` at the pointer: right of it, start-aligned, 2px out,
 *    flipping and shifting at the edges as Radix does.
 *  - The menu takes focus; the pointer focuses the item it hovers; arrows,
 *    Home / End and typing move focus; Enter, Space or a click choose.
 *  - It is modal: the page is aria-hidden, takes no pointer events and
 *    doesn't scroll; Escape and a pointerdown outside close it (with the
 *    exit fade), and focus goes back where it was.
 *  - Choosing an item closes it at once, with no fade: the app's ContextMenu
 *    remounts its Root on select, which skips the exit animation.
 *
 * Items are data (`items` view input); a choice comes back as the `Selected`
 * OutMessage with the item's `value`, and the parent does the work (React's
 * `onSelect`). `Opened` / `Closed` OutMessages stand in for `onOpenChange`.
 *
 * Wiring:
 *   Model:   rowMenu: ContextMenu.Model                    init: ContextMenu.init({ id: "chat-row-c1" })
 *   Message: GotRowMenuMessage: { message: ContextMenu.Message }
 *   update:  GotRowMenuMessage: ({ message }) => foldRowMenu(model, message)
 *              (foldOutMessage: Selected: ({ value }) => …, Opened / Closed: …)
 *   view:
 *     h.submodel({ slotId: "chat-row-c1", model: model.rowMenu, view: ContextMenu.view,
 *       viewInputs: {
 *         items: [ContextMenu.item({ value: "rename" }), ContextMenu.separator(), …],
 *         renderItem: (value) => ROW_MENU_LABELS[value],
 *         toView: ({ trigger, portal }) => h.div([...trigger, h.Class("row")], [title, portal]),
 *       },
 *       toParentMessage: (message) => GotRowMenuMessage({ message }) })
 */

export const contentId = (id: string) => `${id}-context-menu`

/**
 * The last contextmenu event's point. A Foldkit OnContextMenu carries no
 * position, and Radix opened the menu at the event's: Shift+F10 puts it
 * beside the focused element, not where the pointer last pressed. The
 * content's Mount, right after, places the menu there.
 */
let lastContextMenu: { x: number; y: number; at: number } | null = null
/** How recent the event must be to be the one that opened the menu being mounted. */
const CONTEXT_MENU_EVENT_FRESH_MS = 1_000
if (typeof document !== "undefined" && !(globalThis as { __kannaContextMenuPoint?: boolean }).__kannaContextMenuPoint) {
  ;(globalThis as { __kannaContextMenuPoint?: boolean }).__kannaContextMenuPoint = true
  document.addEventListener("contextmenu", (event) => {
    lastContextMenu = { x: event.clientX, y: event.clientY, at: performance.now() }
  }, true)
}

/**
 * Radix's Menu root `isUsingKeyboardRef`: a keydown says the keyboard is in
 * use until the pointer next moves or presses. Opened from the keyboard, the
 * menu's first item takes focus (the roving group's entry focus).
 */
let usingKeyboard = false
if (typeof document !== "undefined" && !(globalThis as { __kannaContextMenuKeyboard?: boolean }).__kannaContextMenuKeyboard) {
  ;(globalThis as { __kannaContextMenuKeyboard?: boolean }).__kannaContextMenuKeyboard = true
  const pointer = () => {
    usingKeyboard = false
  }
  document.addEventListener("keydown", () => {
    usingKeyboard = true
  }, true)
  document.addEventListener("pointerdown", pointer, true)
  document.addEventListener("pointermove", pointer, true)
}

/** Where a menu opening now goes: the contextmenu event's point while it is fresh, else the model's. */
function openingPoint(x: number, y: number) {
  const recent = lastContextMenu
  lastContextMenu = null
  return recent && performance.now() - recent.at < CONTEXT_MENU_EVENT_FRESH_MS ? recent : { x, y }
}
const LONG_PRESS_MS = 700

// MODEL

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

export const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })

export const Model = Schema.Struct({
  id: Schema.String,
  phase: Phase,
  version: Schema.Number,
  /** Bumped by every fading close, so an older exit wait is ignored. */
  exitVersion: Schema.Number,
  point: Point,
  /** Where the last right-button press was: the contextmenu event that follows opens there. */
  pressedAt: Schema.Option(Point),
  /** A touch press waiting out the long-press delay. */
  longPressVersion: Schema.Option(Schema.Number),
  highlighted: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export function init(config: { id: string }): Model {
  return {
    id: config.id,
    phase: "Closed",
    version: 0,
    exitVersion: 0,
    point: { x: 0, y: 0 },
    pressedAt: Option.none(),
    longPressVersion: Option.none(),
    highlighted: Option.none(),
  }
}

export const isOpen = (model: Model) => model.phase === "Open"

// MESSAGE

export const Message = defineMessageUnion({
  /** The content's Mount finished setting up (portal, position, listeners). */
  CompletedMountContent: {},
  PressedTrigger: { pointerType: Schema.String, button: Schema.Number, x: Schema.Number, y: Schema.Number },
  RequestedContextMenu: {},
  CancelledLongPress: {},
  CompletedLongPress: { version: Schema.Number },
  ChoseItem: { value: Schema.String },
  FocusedItem: { value: Schema.String },
  BlurredItem: { value: Schema.String },
  DismissedContent: {},
  CompletedExitAnimation: { version: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Opened: {},
  Closed: {},
  Selected: { value: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const WaitForLongPress = Command.define("WaitForContextMenuLongPress", {
  args: { version: Schema.Number },
  messages: [Message.CompletedLongPress],
  execute: ({ version }) => Effect.sleep(Duration.millis(LONG_PRESS_MS)).pipe(Effect.as(Message.CompletedLongPress({ version }))),
})

export const WaitForExitAnimation = Command.define("WaitForContextMenuExitAnimation", {
  args: { id: Schema.String, version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ id, version }) =>
    waitForExitAnimation(() => document.getElementById(contentId(id))).pipe(Effect.as(Message.CompletedExitAnimation({ version }))),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

function openAt(model: Model, point: { x: number; y: number }): UpdateReturn {
  const opened = modifyFields(model, {
    point: () => point,
    version: Number.increment,
    longPressVersion: () => Option.none(),
    highlighted: () => Option.none(),
  })
  // Already open (a second right click): Radix moves the menu to the new point.
  if (model.phase === "Open") return { model: opened }
  return { model: modifyFields(opened, { phase: () => "Open" as const }), outMessage: OutMessage.Opened() }
}

/** Closes the menu from the parent, with the exit fade. */
export function close(model: Model): UpdateReturn {
  if (model.phase !== "Open") return { model }
  const exitVersion = Number.increment(model.exitVersion)
  return {
    model: modifyFields(model, { phase: () => "Closing" as const, exitVersion: () => exitVersion, highlighted: () => Option.none() }),
    commands: [WaitForExitAnimation({ id: model.id, version: exitVersion })],
    outMessage: OutMessage.Closed(),
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedMountContent: () => ({ model }),
    PressedTrigger: ({ pointerType, button, x, y }) => {
      if (pointerType === "touch" || pointerType === "pen") {
        const version = Number.increment(model.version)
        return {
          model: modifyFields(model, { version: () => version, longPressVersion: () => Option.some(version), pressedAt: () => Option.some({ x, y }) }),
          commands: [WaitForLongPress({ version })],
        }
      }
      return { model: modifyFields(model, { pressedAt: () => (button === 2 ? Option.some({ x, y }) : Option.none()) }) }
    },
    // The contextmenu event: at the right-button press, or (from the keyboard)
    // where the last menu opened.
    RequestedContextMenu: () => openAt(model, Option.getOrElse(model.pressedAt, () => model.point)),
    CancelledLongPress: () => ({ model: modifyFields(model, { longPressVersion: () => Option.none() }) }),
    CompletedLongPress: ({ version }) =>
      Option.contains(model.longPressVersion, version) ? openAt(model, Option.getOrElse(model.pressedAt, () => model.point)) : { model },
    // The app's ContextMenu remounts on select: closed at once, no fade.
    ChoseItem: ({ value }) =>
      model.phase === "Open"
        ? {
          model: modifyFields(model, { phase: () => "Closed" as const, version: Number.increment, highlighted: () => Option.none() }),
          outMessage: OutMessage.Selected({ value }),
        }
        : { model },
    FocusedItem: ({ value }) => ({ model: modifyFields(model, { highlighted: () => Option.some(value) }) }),
    BlurredItem: ({ value }) =>
      Option.contains(model.highlighted, value) ? { model: modifyFields(model, { highlighted: () => Option.none() }) } : { model },
    DismissedContent: () => close(model),
    CompletedExitAnimation: ({ version }) =>
      version === model.exitVersion && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const }) }
        : { model },
  })

// MOUNT

const ITEM_SELECTOR = "[role=menuitem]"
const ROVING_FOCUS_INTENT: Record<string, "first" | "last" | "prev" | "next"> = {
  ArrowUp: "prev",
  ArrowDown: "next",
  PageUp: "first",
  Home: "first",
  PageDown: "last",
  End: "last",
}
const FIRST_KEYS = ["ArrowDown", "PageUp", "Home"]
const LAST_KEYS = ["ArrowUp", "PageDown", "End"]

/** On the popper wrapper: portal, position at the point, modality, menu focus. */
export const ContextMenuContent = Mount.defineStream("ContextMenuContent", {
  args: { id: Schema.String, x: Schema.Number, y: Schema.Number },
  messages: [Message.CompletedMountContent, Message.DismissedContent],
  execute: ({ element, x, y }) =>
    domStream<typeof Message.CompletedMountContent.Type | typeof Message.DismissedContent.Type>((emit) => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const cleanups: Array<() => void> = []
      const items = () => Array.from(content.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter((item) => !item.hasAttribute("data-disabled"))

      cleanups.push(portalToBody(wrapper))
      const point = openingPoint(x, y)
      cleanups.push(placePopper(wrapper, content, pointReference(point.x, point.y), {
        side: "right",
        align: "start",
        sideOffset: 2,
        alignOffset: 0,
        avoidCollisions: true,
        collisionPadding: 0,
      }))
      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: true,
        shouldDismiss: ({ reason }) => reason !== "focus-outside",
        onDismiss: () => emit(Message.DismissedContent()),
      }))
      // The app's ContextMenu remounts its Root on select, trigger and all,
      // so Radix gave focus back to an element no longer in the page and it
      // fell to <body>: after a choice, focus held inside the trigger isn't
      // restored. (The trigger is the open one holding what had focus.)
      const focusedBefore = document.activeElement
      const trigger = focusedBefore instanceof HTMLElement ? focusedBefore.closest<HTMLElement>("[data-state='open']") : null
      let chose = false
      const isChoice = (event: Event) => {
        const chosen = event.target instanceof Element ? event.target.closest(ITEM_SELECTOR) : null
        return chosen !== null && content.contains(chosen) && !chosen.hasAttribute("data-disabled")
      }
      const handleChoiceClick = (event: MouseEvent) => {
        if (isChoice(event)) chose = true
      }
      const handleChoiceKey = (event: KeyboardEvent) => {
        if ((event.key === "Enter" || event.key === " ") && isChoice(event)) chose = true
      }
      content.addEventListener("click", handleChoiceClick, true)
      content.addEventListener("keydown", handleChoiceKey, true)
      cleanups.push(() => {
        content.removeEventListener("click", handleChoiceClick, true)
        content.removeEventListener("keydown", handleChoiceKey, true)
      })
      cleanups.push(installFocusScope(content, {
        trapped: true,
        loop: false,
        // The menu itself takes focus on open, not its first item.
        onMountAutoFocus: () => {
          content.focus({ preventScroll: true })
          if (usingKeyboard) items()[0]?.focus({ preventScroll: true })
          return true
        },
        onUnmountAutoFocus: (previous) => chose && trigger !== null && previous !== null && trigger.contains(previous),
      }))
      cleanups.push(installFocusGuards(document))
      cleanups.push(hideOthers(content))
      cleanups.push(lockScroll(document, [content]))

      const typeahead = createTypeahead()
      cleanups.push(() => typeahead.dispose())
      const handleKeyDown = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement
        const isKeyDownInside = target.closest("[data-radix-menu-content]") === content
        const isModifierKey = event.ctrlKey || event.altKey || event.metaKey
        if (isKeyDownInside) {
          if (event.key === "Tab") event.preventDefault()
          if (!isModifierKey && event.key.length === 1) {
            const search = typeahead.type(event.key)
            const enabled = items()
            const current = enabled.find((item) => item === document.activeElement)
            const next = findNextMatch(enabled, (item) => (item.textContent ?? "").trim(), search, current)
            if (next) setTimeout(() => next.focus())
          }
        }
        // Keys between items: Radix's RovingFocusGroup (vertical, no loop).
        // It moves focus a task later, from the item the key was pressed on,
        // so two quick presses both start from that item.
        const enabled = items()
        const index = enabled.indexOf(target)
        const intent = ROVING_FOCUS_INTENT[event.key]
        if (index !== -1 && intent !== undefined) {
          event.preventDefault()
          let candidates = intent === "last" || intent === "prev" ? enabled.slice().reverse() : enabled
          if (intent === "prev" || intent === "next") candidates = candidates.slice(candidates.indexOf(target) + 1)
          setTimeout(() => {
            for (const candidate of candidates) {
              const previous = document.activeElement
              candidate.focus({ preventScroll: true })
              if (document.activeElement !== previous) break
            }
          })
          return
        }
        if (target !== content || ![...FIRST_KEYS, ...LAST_KEYS].includes(event.key)) return
        event.preventDefault()
        const candidates = LAST_KEYS.includes(event.key) ? enabled.slice().reverse() : enabled
        for (const candidate of candidates) {
          candidate.focus({ preventScroll: true })
          if (document.activeElement === candidate) break
        }
      }
      const handlePointerMove = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return
        const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM_SELECTOR)
        if (!item || !content.contains(item)) return
        if (item.hasAttribute("data-disabled")) focusElement(content)
        else if (document.activeElement !== item) item.focus({ preventScroll: true })
      }
      const handlePointerOut = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return
        const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM_SELECTOR)
        if (item && !item.contains(event.relatedTarget as Node | null)) content.focus()
      }
      content.addEventListener("keydown", handleKeyDown)
      content.addEventListener("pointermove", handlePointerMove)
      content.addEventListener("pointerout", handlePointerOut)
      cleanups.push(() => {
        content.removeEventListener("keydown", handleKeyDown)
        content.removeEventListener("pointermove", handlePointerMove)
        content.removeEventListener("pointerout", handlePointerOut)
      })

      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// VIEW

export type MenuEntry =
  | { _tag: "Item"; value: string; disabled?: boolean; className?: string; title?: string }
  | { _tag: "Separator"; className?: string }

/** `<ContextMenuItem>`: chosen, it emits `Selected` with this `value`. */
export const item = (config: Omit<Extract<MenuEntry, { _tag: "Item" }>, "_tag">): MenuEntry => ({ _tag: "Item", ...config })
/** `<ContextMenuSeparator>`. */
export const separator = (config: { className?: string } = {}): MenuEntry => ({ _tag: "Separator", ...config })

export interface RenderInfo {
  /** Spread onto the trigger element (Radix's ContextMenuTrigger asChild). */
  trigger: ReadonlyArray<ChildAttribute>
  /** The menu, or nothing while closed. Render it anywhere in the markup. */
  portal: Html
  isOpen: boolean
}

export interface ViewInputs {
  items: ReadonlyArray<MenuEntry>
  /**
   * An item's children, by value (`<ContextMenuItem>`'s children). A
   * top-level function, as Foldkit requires of view-input callbacks.
   */
  renderItem: (value: string) => ReadonlyArray<Child>
  toView: (render: RenderInfo) => Html
  /** `<ContextMenuContent className>`. */
  className?: string
  disabled?: boolean
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const open = model.phase === "Open"
  const state = open ? "open" : "closed"
  const disabled = inputs.disabled ?? false
  const enabledCount = inputs.items.filter((entry) => entry._tag === "Item" && !entry.disabled).length

  const trigger = childAttributes([
    h.DataAttribute("state", state),
    ...(disabled ? [h.DataAttribute("disabled", "")] : []),
    // React also wrote `-webkit-touch-callout: none` (iOS Safari only, which
    // Foldkit's style module rejects): left out.
    ...(disabled
      ? []
      : [
        h.OnContextMenu(Message.RequestedContextMenu()),
        h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) =>
          // Radix positions from the contextmenu event, whose coordinates
          // Chromium truncates to whole pixels; pointerdown's are fractional.
          Option.some(Message.PressedTrigger({ pointerType, button, x: Math.trunc(clientX), y: Math.trunc(clientY) }))),
        h.OnPointerMove((_x, _y, pointerType) =>
          pointerType !== "mouse" && Option.isSome(model.longPressVersion) ? Option.some(Message.CancelledLongPress()) : Option.none()),
        h.OnPointerUp((_x, _y, pointerType) =>
          pointerType !== "mouse" && Option.isSome(model.longPressVersion) ? Option.some(Message.CancelledLongPress()) : Option.none()),
      ]),
  ])

  const entry = (config: MenuEntry, index: number) => {
    if (config._tag === "Separator") {
      return h.keyed("div")(`separator-${index}`, [
        h.Role("separator"),
        h.AriaOrientation("horizontal"),
        h.Class(cn("-mx-1 my-1 h-px bg-border", config.className)),
      ])
    }
    const isFocused = Option.contains(model.highlighted, config.value)
    const itemDisabled = config.disabled ?? false
    return h.keyed("div")(config.value, [
      h.Role("menuitem"),
      ...(isFocused ? [h.DataAttribute("highlighted", "")] : []),
      ...(itemDisabled ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : []),
      ...(config.title !== undefined ? [h.Title(config.title)] : []),
      h.Tabindex(-1),
      h.DataAttribute("orientation", "vertical"),
      h.Class(cn(
        "relative flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground outline-hidden transition-colors hover:bg-muted focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        config.className,
      )),
      h.OnFocus(Message.FocusedItem({ value: config.value })),
      h.OnBlur(Message.BlurredItem({ value: config.value })),
      ...(itemDisabled
        ? []
        : [
          h.OnClick(Message.ChoseItem({ value: config.value })),
          h.OnKeyDownPreventDefault((key) => (key === "Enter" || key === " " ? Option.some(Message.ChoseItem({ value: config.value })) : Option.none())),
        ]),
    ], inputs.renderItem(config.value))
  }

  const portal = model.phase !== "Closed"
    ? h.keyed("div")(`${model.id}-context-menu-${model.point.x}-${model.point.y}`, [
      h.DataAttribute("radix-popper-content-wrapper", ""),
      h.Style(POPPER_WRAPPER_INITIAL_STYLE),
      h.OnMount(ContextMenuContent({ id: model.id, x: model.point.x, y: model.point.y })),
    ], [
      h.div([
        h.DataAttribute("side", "right"),
        h.DataAttribute("align", "start"),
        h.Role("menu"),
        h.Id(contentId(model.id)),
        h.AriaOrientation("vertical"),
        h.DataAttribute("state", state),
        h.DataAttribute("radix-menu-content", ""),
        h.Dir("ltr"),
        h.Tabindex(enabledCount > 0 ? 0 : -1),
        h.DataAttribute("orientation", "vertical"),
        h.Class(cn(
          "z-50 min-w-[170px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg outline-hidden floating-surface",
          inputs.className,
        )),
        h.Style({
          outline: "none",
          "--radix-context-menu-content-transform-origin": "var(--radix-popper-transform-origin)",
          "--radix-context-menu-content-available-width": "var(--radix-popper-available-width)",
          "--radix-context-menu-content-available-height": "var(--radix-popper-available-height)",
          "--radix-context-menu-trigger-width": "var(--radix-popper-anchor-width)",
          "--radix-context-menu-trigger-height": "var(--radix-popper-anchor-height)",
        }),
      ], inputs.items.map(entry)),
    ])
    : null

  return inputs.toView({ trigger, portal, isOpen: open })
})
