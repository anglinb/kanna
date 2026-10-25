import { Effect, Number, Option, Schema } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { childAttributes, type ChildAttribute, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { cn } from "../../client/lib/utils"
import type { Child, ExtraAttributes } from "./attributes"
import { Check, ChevronDown, ChevronUp } from "./icons"
import { focusElement, installFocusGuards, installFocusScope } from "./overlay/focus"
import { registerLayer } from "./overlay/layer"
import { hideOthers, lockScroll } from "./overlay/modal"
import { placePopper, POPPER_WRAPPER_INITIAL_STYLE, type Align, type Side } from "./overlay/popper"
import { portalToBody } from "./overlay/portal"
import { waitForExitAnimation } from "./overlay/presence"
import { domStream } from "./overlay/stream"
import { createTypeahead, findNextMatch } from "./overlay/typeahead"

/**
 * `<Select>` with `<SelectTrigger>`, `<SelectValue>`, `<SelectContent>`
 * (popper position, the app's only one), `<SelectGroup>` and `<SelectItem>`
 * (src/client/components/ui/select.tsx), with Radix's DOM and behaviour:
 *
 *  - The trigger is a `role="combobox"` button: a mouse press opens it on
 *    pointerdown, touch and pen on click, Enter / Space / arrows from the
 *    keyboard. `data-placeholder` while nothing is chosen.
 *  - The listbox opens below the trigger (flipping above near the bottom
 *    edge), at least as wide as the trigger, with the chosen item focused;
 *    arrows, Home / End and typing move focus through the items, the pointer
 *    focuses what it hovers, Enter / Space / a click choose.
 *  - It is modal while open, as Radix's is: the page is aria-hidden, gets no
 *    pointer events and doesn't scroll; Escape, a pointerdown outside, the
 *    window losing focus or resizing close it, and focus returns to the
 *    trigger.
 *  - Scroll buttons appear when the list overflows.
 *
 * The value is the parent's (`value` view input, as `value=` in React); a
 * choice comes back as the `Selected` OutMessage. The trigger's typeahead
 * (choosing by typing while closed) and the native <select> Radix adds inside
 * a <form> are not ported: no caller uses either.
 *
 * Wiring:
 *   Model:   visibility: Select.Model                     init: Select.init({ id: "visibility" })
 *   Message: GotVisibilityMessage: { message: Select.Message }
 *   update:  GotVisibilityMessage: ({ message }) => foldVisibility(model, message)
 *              (foldOutMessage: Selected: ({ value }) => (m) => ({ model: { ...m, visibility: value } }))
 *   view:
 *     h.submodel({ slotId: "visibility", model: model.visibility, view: Select.view,
 *       viewInputs: {
 *         value: model.visibility, placeholder: "Select visibility",
 *         items: [{ value: "private" }, { value: "public" }],
 *         renderItem: (value) => [value === "private" ? "Private" : "Public"],
 *         toView: ({ trigger, value, portal }) => Select.selectTrigger({ attributes: trigger }, [value], portal, h),
 *       },
 *       toParentMessage: (message) => GotVisibilityMessage({ message }) })
 */

export const contentId = (id: string) => `${id}-select-content`
const itemTextId = (id: string, index: number) => `${id}-select-item-${index}-text`

const VIEWPORT_STYLE = "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}"
const CONTENT_MARGIN = 10

// MODEL

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

export const Model = Schema.Struct({
  id: Schema.String,
  phase: Phase,
  version: Schema.Number,
  /** The focused item's value: Radix's data-highlighted and aria-selected. */
  highlighted: Schema.Option(Schema.String),
  canScrollUp: Schema.Boolean,
  canScrollDown: Schema.Boolean,
  /** The last pointer on the trigger: a mouse opens on press, others on click. */
  triggerPointerType: Schema.String,
  /** Where a mouse press opened it, so the release that follows can't pick an item. */
  openedAt: Schema.Option(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
  /** The last pointer on an item: a mouse chooses on release, others on click. */
  itemPointerType: Schema.String,
})
export type Model = typeof Model.Type

export function init(config: { id: string }): Model {
  return {
    id: config.id,
    phase: "Closed",
    version: 0,
    highlighted: Option.none(),
    canScrollUp: false,
    canScrollDown: false,
    triggerPointerType: "touch",
    openedAt: Option.none(),
    itemPointerType: "touch",
  }
}

export const isOpen = (model: Model) => model.phase === "Open"

// MESSAGE

export const Message = defineMessageUnion({
  /** The content's Mount finished setting up (portal, position, listeners). */
  CompletedMountContent: {},
  /** The trigger's Mount is listening (see SelectTrigger). */
  CompletedMountTrigger: {},
  PressedTrigger: { pointerType: Schema.String, button: Schema.Number, x: Schema.Number, y: Schema.Number, disabled: Schema.Boolean },
  ClickedTrigger: { disabled: Schema.Boolean },
  PressedOpenKey: {},
  PressedItem: { pointerType: Schema.String },
  ChoseItem: { value: Schema.String, pointerType: Schema.String },
  FocusedItem: { value: Schema.String },
  BlurredItem: { value: Schema.String },
  DismissedContent: {},
  ChangedScrollability: { up: Schema.Boolean, down: Schema.Boolean },
  CompletedExitAnimation: { version: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Selected: { value: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const WaitForExitAnimation = Command.define("WaitForSelectExitAnimation", {
  args: { id: Schema.String, version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ id, version }) =>
    waitForExitAnimation(() => document.getElementById(contentId(id))).pipe(Effect.as(Message.CompletedExitAnimation({ version }))),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

function open(model: Model, openedAt: Option.Option<{ x: number; y: number }>): UpdateReturn {
  if (model.phase === "Open") return { model }
  return {
    model: modifyFields(model, {
      phase: () => "Open" as const,
      version: Number.increment,
      openedAt: () => openedAt,
      highlighted: () => Option.none(),
      canScrollUp: () => false,
      canScrollDown: () => false,
    }),
  }
}

/** Closes the listbox from the parent. */
export function close(model: Model): Update.Return<Model, Message> {
  if (model.phase !== "Open") return { model }
  const version = Number.increment(model.version)
  return {
    model: modifyFields(model, { phase: () => "Closing" as const, version: () => version, highlighted: () => Option.none() }),
    commands: [WaitForExitAnimation({ id: model.id, version })],
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedMountContent: () => ({ model }),
    CompletedMountTrigger: () => ({ model }),
    PressedTrigger: ({ pointerType, button, x, y, disabled }) => {
      const pressed = modifyFields(model, { triggerPointerType: () => pointerType })
      if (disabled || pointerType !== "mouse" || button !== 0) return { model: pressed }
      return open(pressed, Option.some({ x, y }))
    },
    ClickedTrigger: ({ disabled }) =>
      disabled || model.triggerPointerType === "mouse" ? { model } : open(model, Option.none()),
    PressedOpenKey: () => open(model, Option.none()),
    PressedItem: ({ pointerType }) => ({ model: modifyFields(model, { itemPointerType: () => pointerType }) }),
    ChoseItem: ({ value }) => ({ ...close(model), outMessage: OutMessage.Selected({ value }) }),
    FocusedItem: ({ value }) => ({ model: modifyFields(model, { highlighted: () => Option.some(value) }) }),
    BlurredItem: ({ value }) =>
      Option.contains(model.highlighted, value)
        ? { model: modifyFields(model, { highlighted: () => Option.none() }) }
        : { model },
    DismissedContent: () => close(model),
    ChangedScrollability: ({ up, down }) => ({ model: modifyFields(model, { canScrollUp: () => up, canScrollDown: () => down }) }),
    CompletedExitAnimation: ({ version }) =>
      version === model.version && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const }) }
        : { model },
  })

// MOUNT

/**
 * On the trigger: what Radix's trigger does with the DOM event itself. A
 * mouse press doesn't move focus (`preventDefault` on pointerdown, so the
 * trigger isn't focused by the mouse) and the click focuses the trigger from
 * script. The difference shows: focus that arrives by script keeps
 * `:focus-visible`, so the chosen item the listbox focuses next draws the
 * same focus outline it does in React.
 */
export const SelectTrigger = Mount.define("SelectTrigger", {
  args: { id: Schema.String },
  messages: [Message.CompletedMountTrigger],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const trigger = element as HTMLElement
          const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Element
            if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
            if (event.button === 0 && !event.ctrlKey && event.pointerType === "mouse") event.preventDefault()
          }
          const handleClick = () => trigger.focus()
          trigger.addEventListener("pointerdown", handlePointerDown)
          trigger.addEventListener("click", handleClick)
          return () => {
            trigger.removeEventListener("pointerdown", handlePointerDown)
            trigger.removeEventListener("click", handleClick)
          }
        }),
        (cleanup) => Effect.sync(cleanup),
      )
      return Message.CompletedMountTrigger()
    }),
})

const ITEM_SELECTOR = "[role=option]"

/**
 * On the popper wrapper: portal, position, the modal machinery, and the
 * listbox's focus handling (Radix does all of it with DOM focus, and so does
 * this): the chosen item takes focus once placed, arrows and typing move it,
 * the pointer moves it, and the scroll buttons scroll while hovered.
 */
export const SelectContent = Mount.defineStream("SelectContent", {
  args: {
    id: Schema.String,
    side: Schema.String,
    align: Schema.String,
    sideOffset: Schema.Number,
    alignOffset: Schema.Number,
    openedAtX: Schema.Number,
    openedAtY: Schema.Number,
  },
  messages: [Message.CompletedMountContent, Message.DismissedContent, Message.ChangedScrollability],
  execute: ({ element, id, side, align, sideOffset, alignOffset, openedAtX, openedAtY }) =>
    domStream<typeof Message.CompletedMountContent.Type | typeof Message.DismissedContent.Type | typeof Message.ChangedScrollability.Type>((emit) => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const viewport = content.querySelector<HTMLElement>("[data-radix-select-viewport]")!
      const trigger = document.querySelector<HTMLElement>(`[data-select-trigger="${CSS.escape(id)}"]`)
      const cleanups: Array<() => void> = []
      const dismiss = () => emit(Message.DismissedContent())
      const items = () => Array.from(content.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
      const enabledItems = () => items().filter((item) => !item.hasAttribute("data-disabled"))

      const focusFirst = (candidates: ReadonlyArray<HTMLElement | null>) => {
        const all = items()
        const first = all[0]
        const last = all[all.length - 1]
        const previous = document.activeElement
        for (const candidate of candidates) {
          if (candidate === previous) return
          candidate?.scrollIntoView({ block: "nearest" })
          if (candidate === first) viewport.scrollTop = 0
          if (candidate === last) viewport.scrollTop = viewport.scrollHeight
          candidate?.focus()
          if (document.activeElement !== previous) return
        }
      }

      const reportScrollability = () => {
        const up = viewport.scrollTop > 0
        const down = Math.ceil(viewport.scrollTop) < viewport.scrollHeight - viewport.clientHeight
        emit(Message.ChangedScrollability({ up, down }))
      }

      cleanups.push(portalToBody(wrapper))
      if (trigger) {
        cleanups.push(placePopper(wrapper, content, trigger, {
          side: side as Side,
          align: align as Align,
          sideOffset,
          alignOffset,
          avoidCollisions: true,
          collisionPadding: CONTENT_MARGIN,
        }, () => {
          const selected = content.querySelector<HTMLElement>(`${ITEM_SELECTOR}[data-state=checked]`)
          focusFirst([selected ?? enabledItems()[0] ?? null, content])
          reportScrollability()
        }))
      }
      viewport.addEventListener("scroll", reportScrollability)
      cleanups.push(() => viewport.removeEventListener("scroll", reportScrollability))

      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: true,
        shouldDismiss: ({ reason }) => reason !== "focus-outside",
        onDismiss: dismiss,
      }))
      cleanups.push(installFocusScope(content, {
        trapped: true,
        loop: false,
        onMountAutoFocus: () => true,
        onUnmountAutoFocus: () => {
          trigger?.focus({ preventScroll: true })
          return true
        },
      }))
      cleanups.push(installFocusGuards(document))
      cleanups.push(hideOthers(content))
      cleanups.push(lockScroll(document, [content]))

      // A mouse press opened it: the release that follows doesn't choose an
      // item unless the pointer travelled first, and outside it closes.
      if (openedAtX >= 0) {
        let delta = { x: 0, y: 0 }
        const handlePointerMove = (event: PointerEvent) => {
          delta = { x: Math.abs(Math.round(event.clientX) - openedAtX), y: Math.abs(Math.round(event.clientY) - openedAtY) }
        }
        const handlePointerUp = (event: PointerEvent) => {
          if (delta.x <= 10 && delta.y <= 10) event.stopPropagation()
          else if (!content.contains(event.target as Node)) dismiss()
          document.removeEventListener("pointermove", handlePointerMove)
        }
        document.addEventListener("pointermove", handlePointerMove)
        document.addEventListener("pointerup", handlePointerUp, { capture: true, once: true })
        cleanups.push(() => {
          document.removeEventListener("pointermove", handlePointerMove)
          document.removeEventListener("pointerup", handlePointerUp, { capture: true })
        })
      }

      window.addEventListener("blur", dismiss)
      window.addEventListener("resize", dismiss)
      cleanups.push(() => {
        window.removeEventListener("blur", dismiss)
        window.removeEventListener("resize", dismiss)
      })

      const typeahead = createTypeahead()
      cleanups.push(() => typeahead.dispose())
      const handleKeyDown = (event: KeyboardEvent) => {
        const isModifierKey = event.ctrlKey || event.altKey || event.metaKey
        if (event.key === "Tab") event.preventDefault()
        if (!isModifierKey && event.key.length === 1) {
          const search = typeahead.type(event.key)
          const enabled = enabledItems()
          const current = enabled.find((item) => item === document.activeElement)
          const next = findNextMatch(enabled, (item) => (item.textContent ?? "").trim(), search, current)
          if (next) setTimeout(() => next.focus())
        }
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          let candidates = enabledItems()
          if (["ArrowUp", "End"].includes(event.key)) candidates = candidates.slice().reverse()
          if (["ArrowUp", "ArrowDown"].includes(event.key)) {
            const index = candidates.indexOf(event.target as HTMLElement)
            candidates = candidates.slice(index + 1)
          }
          setTimeout(() => focusFirst(candidates))
          event.preventDefault()
        }
      }
      const handleContextMenu = (event: MouseEvent) => event.preventDefault()
      // Mouse hover focuses an item; leaving it (or moving onto a disabled
      // one or a scroll button) hands focus back to the content.
      const handlePointerMove = (event: PointerEvent) => {
        const target = event.target as HTMLElement
        const item = target.closest<HTMLElement>(ITEM_SELECTOR)
        if (item && content.contains(item)) {
          if (item.hasAttribute("data-disabled")) focusElement(content)
          else if (event.pointerType === "mouse" && document.activeElement !== item) item.focus({ preventScroll: true })
        }
      }
      const handlePointerOut = (event: PointerEvent) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>(ITEM_SELECTOR)
        if (item && item === document.activeElement && !item.contains(event.relatedTarget as Node | null)) focusElement(content)
      }
      let autoScroll = 0
      const stopAutoScroll = () => {
        window.clearInterval(autoScroll)
        autoScroll = 0
      }
      const handleScrollButton = (event: PointerEvent) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>("[data-select-scroll]")
        if (!button || autoScroll) return
        if (event.type === "pointermove") focusElement(content)
        const direction = button.dataset.selectScroll === "up" ? -1 : 1
        autoScroll = window.setInterval(() => {
          const selected = content.querySelector<HTMLElement>(`${ITEM_SELECTOR}[data-state=checked]`) ?? items()[0]
          viewport.scrollTop += direction * (selected?.offsetHeight ?? 32)
        }, 50)
      }
      const handleScrollButtonLeave = (event: PointerEvent) => {
        if ((event.target as HTMLElement).closest("[data-select-scroll]")) stopAutoScroll()
      }
      content.addEventListener("keydown", handleKeyDown)
      content.addEventListener("contextmenu", handleContextMenu)
      content.addEventListener("pointermove", handlePointerMove)
      content.addEventListener("pointerout", handlePointerOut)
      content.addEventListener("pointerdown", handleScrollButton)
      content.addEventListener("pointermove", handleScrollButton)
      content.addEventListener("pointerout", handleScrollButtonLeave)
      cleanups.push(() => {
        stopAutoScroll()
        content.removeEventListener("keydown", handleKeyDown)
        content.removeEventListener("contextmenu", handleContextMenu)
        content.removeEventListener("pointermove", handlePointerMove)
        content.removeEventListener("pointerout", handlePointerOut)
        content.removeEventListener("pointerdown", handleScrollButton)
        content.removeEventListener("pointermove", handleScrollButton)
        content.removeEventListener("pointerout", handleScrollButtonLeave)
      })

      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// VIEW

export interface SelectItemConfig {
  value: string
  disabled?: boolean
  className?: string
}

export interface RenderInfo {
  /** Spread onto the trigger button (or use `selectTrigger`). */
  trigger: ReadonlyArray<ChildAttribute>
  /** `<SelectValue>`: the chosen item's label, or the placeholder. */
  value: Html
  /** The listbox, or nothing while closed. Render it anywhere in the markup. */
  portal: Html
  isOpen: boolean
}

export interface ViewInputs {
  /** The chosen value (React's `value`); nothing chosen shows the placeholder. */
  value: string | undefined
  placeholder?: string
  items: ReadonlyArray<SelectItemConfig>
  /**
   * An item's label, by value: rendered in the list and, for the chosen one,
   * in the trigger (`<SelectItem>`'s children). A top-level function, as
   * Foldkit requires of view-input callbacks.
   */
  renderItem: (value: string) => ReadonlyArray<Child>
  /** Wrap the items in a `<SelectGroup>` (role="group"), as most callers do. */
  grouped?: boolean
  disabled?: boolean
  toView: (render: RenderInfo) => Html
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  /** `<SelectContent className>`. */
  className?: string
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const open = model.phase === "Open"
  const state = open ? "open" : "closed"
  const disabled = inputs.disabled ?? false
  const hasValue = inputs.value !== undefined && inputs.value !== ""
  const chosen = inputs.items.find((item) => item.value === inputs.value)
  const side = inputs.side ?? "bottom"
  const align = inputs.align ?? "start"

  const trigger = childAttributes([
    h.DataAttribute("select-trigger", model.id),
    h.Type("button"),
    h.Role("combobox"),
    h.AriaControls(contentId(model.id)),
    h.AriaExpanded(open),
    h.AriaAutocomplete("none"),
    h.Dir("ltr"),
    h.DataAttribute("state", state),
    ...(disabled ? [h.Disabled(true), h.DataAttribute("disabled", "")] : []),
    ...(hasValue ? [] : [h.DataAttribute("placeholder", "")]),
    h.OnPointerDown((pointerType, button, _screenX, _screenY, _timeStamp, clientX, clientY) =>
      Option.some(Message.PressedTrigger({ pointerType, button, x: Math.round(clientX), y: Math.round(clientY), disabled }))),
    h.OnClick(Message.ClickedTrigger({ disabled })),
    h.OnKeyDownPreventDefault((key) =>
      [" ", "Enter", "ArrowUp", "ArrowDown"].includes(key) && !disabled ? Option.some(Message.PressedOpenKey()) : Option.none()),
    h.OnMount(SelectTrigger({ id: model.id })),
  ])

  const value = h.span([h.Style({ "pointer-events": "none" })], hasValue && chosen ? inputs.renderItem(chosen.value) : [inputs.placeholder ?? ""])

  const item = (config: SelectItemConfig, index: number) => {
    const isSelected = config.value === inputs.value
    const isFocused = Option.contains(model.highlighted, config.value)
    const itemDisabled = config.disabled ?? false
    return h.keyed("div")(config.value, [
      h.Role("option"),
      h.AriaLabelledBy(itemTextId(model.id, index)),
      ...(isFocused ? [h.DataAttribute("highlighted", "")] : []),
      h.AriaSelected(isSelected && isFocused),
      h.DataAttribute("state", isSelected ? "checked" : "unchecked"),
      ...(itemDisabled ? [h.AriaDisabled(true), h.DataAttribute("disabled", "")] : [h.Tabindex(-1)]),
      h.Class(cn(
        "relative flex w-full cursor-default select-none items-center rounded-md py-1.5 pl-2 pr-8 text-sm outline-none",
        "focus:bg-accent focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        config.className,
      )),
      h.OnFocus(Message.FocusedItem({ value: config.value })),
      h.OnBlur(Message.BlurredItem({ value: config.value })),
      h.OnPointerDown((pointerType) => Option.some(Message.PressedItem({ pointerType }))),
      h.OnPointerUp((_x, _y, pointerType) =>
        pointerType === "mouse" && !itemDisabled ? Option.some(Message.ChoseItem({ value: config.value, pointerType })) : Option.none()),
      ...(model.itemPointerType !== "mouse" && !itemDisabled ? [h.OnClick(Message.ChoseItem({ value: config.value, pointerType: model.itemPointerType }))] : []),
      h.OnKeyDownPreventDefault((key) =>
        itemDisabled ? Option.none() : key === " " || key === "Enter" ? Option.some(Message.ChoseItem({ value: config.value, pointerType: "keyboard" })) : Option.none()),
    ], [
      h.span([h.Class("absolute right-2 flex h-3.5 w-3.5 items-center justify-center")], [
        isSelected ? h.span([h.AriaHidden(true)], [Check({ class: "h-4 w-4" }, h)]) : null,
      ]),
      h.span([h.Id(itemTextId(model.id, index))], inputs.renderItem(config.value)),
    ])
  }

  const items = inputs.items.map(item)

  const scrollButton = (direction: "up" | "down") =>
    h.div([
      h.AriaHidden(true),
      h.DataAttribute("select-scroll", direction),
      h.Class("flex cursor-default items-center justify-center py-1"),
      h.Style({ "flex-shrink": "0" }),
    ], [(direction === "up" ? ChevronUp : ChevronDown)({ class: "h-4 w-4" }, h)])

  const portal = model.phase !== "Closed"
    ? h.keyed("div")(`${model.id}-select`, [
      h.DataAttribute("radix-popper-content-wrapper", ""),
      h.Style(POPPER_WRAPPER_INITIAL_STYLE),
      h.OnMount(SelectContent({
        id: model.id,
        side,
        align,
        sideOffset: inputs.sideOffset ?? 0,
        alignOffset: inputs.alignOffset ?? 0,
        openedAtX: Option.match(model.openedAt, { onNone: () => -1, onSome: ({ x }) => x }),
        openedAtY: Option.match(model.openedAt, { onNone: () => -1, onSome: ({ y }) => y }),
      })),
    ], [
      h.div([
        h.DataAttribute("side", side),
        h.DataAttribute("align", align),
        h.Role("listbox"),
        h.Id(contentId(model.id)),
        h.DataAttribute("state", state),
        h.Dir("ltr"),
        h.Tabindex(-1),
        h.Class(cn(
          "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-md",
          "floating-surface",
          "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          inputs.className,
        )),
        h.Style({
          "box-sizing": "border-box",
          display: "flex",
          "flex-direction": "column",
          outline: "none",
          "--radix-select-content-transform-origin": "var(--radix-popper-transform-origin)",
          "--radix-select-content-available-width": "var(--radix-popper-available-width)",
          "--radix-select-content-available-height": "var(--radix-popper-available-height)",
          "--radix-select-trigger-width": "var(--radix-popper-anchor-width)",
          "--radix-select-trigger-height": "var(--radix-popper-anchor-height)",
        }),
      ], [
        model.canScrollUp ? scrollButton("up") : null,
        h.style([], [VIEWPORT_STYLE]),
        h.div([
          h.DataAttribute("radix-select-viewport", ""),
          h.Role("presentation"),
          h.Class("p-1 h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]"),
          h.Style({ position: "relative", flex: "1 1 0%", overflow: "hidden auto" }),
        ], inputs.grouped ? [h.div([h.Role("group"), h.AriaLabelledBy(`${model.id}-select-group`)], items)] : items),
        model.canScrollDown ? scrollButton("down") : null,
      ]),
    ])
    : null

  return inputs.toView({ trigger, value, portal, isOpen: open })
})

/**
 * `<SelectTrigger>`: the trigger button with its classes and chevron. Put
 * `value` (or your own markup) in `children` and the `portal` after it.
 *
 *   Select.selectTrigger({ attributes: render.trigger, class: "h-7 w-auto" }, [render.value], render.portal, h)
 */
export function selectTrigger<Message>(
  options: { class?: string; attributes: ExtraAttributes<Message> },
  children: ReadonlyArray<Child>,
  portal: Html,
  h: HtmlBuilder<Message>,
): Html {
  return h.button([
    h.Class(cn(
      "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors",
      "placeholder:text-muted-foreground",
      "focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "[&>span]:line-clamp-1",
      options.class,
    )),
    ...options.attributes,
  ], [...children, ChevronDown({ class: "h-4 w-4 shrink-0 opacity-50" }, h), portal])
}
