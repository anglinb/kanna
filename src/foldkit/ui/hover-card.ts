import { Duration, Effect, Number, Option, Schema } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { childAttributes, type ChildAttribute, type Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { cn } from "../../client/lib/utils"
import type { Child } from "./attributes"
import { registerLayer } from "./overlay/layer"
import { placePopper, POPPER_WRAPPER_INITIAL_STYLE, type Align, type Side } from "./overlay/popper"
import { portalToBody } from "./overlay/portal"
import { waitForExitAnimation } from "./overlay/presence"
import { domStream } from "./overlay/stream"

/**
 * `<HoverCard>` / `<HoverCardTrigger asChild>` / `<HoverCardContent>`
 * (src/client/components/ui/hover-card.tsx): content you can point *at*, as
 * opposed to a tooltip, which you can only point near.
 *
 * Radix's behaviour: the pointer resting on the trigger (or focus) opens it
 * after `openDelay` (700ms); leaving trigger and card closes it after
 * `closeDelay` (300ms), so the pointer can travel into the card; Escape and a
 * pointerdown outside close it at once. Selecting text in the card keeps it
 * open. Tabbables inside the card are taken out of the tab order. No role,
 * no focus management: it is a region the pointer visits.
 *
 * Wiring: as Tooltip (see tooltip.ts), with `HoverCard.init({ id, openDelay?, closeDelay? })`.
 */

export const contentId = (id: string) => `${id}-hover-card`

// MODEL

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

export const Model = Schema.Struct({
  id: Schema.String,
  openDelay: Schema.Number,
  closeDelay: Schema.Number,
  phase: Phase,
  /** Bumped by every pointer/focus change, so a stale delay is ignored. */
  timerVersion: Schema.Number,
  exitVersion: Schema.Number,
  /** Text selected in the card, or a press in progress on it: leaving doesn't close. */
  isHoldingContent: Schema.Boolean,
  /**
   * Where the pointer is, so a visit starts the open delay once (Radix uses
   * pointerenter, which Foldkit has no attribute for; the first pointermove
   * of a visit stands in for it).
   */
  isPointerOnTrigger: Schema.Boolean,
  isPointerOnContent: Schema.Boolean,
})
export type Model = typeof Model.Type

export function init(config: { id: string; openDelay?: number; closeDelay?: number }): Model {
  return {
    id: config.id,
    openDelay: config.openDelay ?? 700,
    closeDelay: config.closeDelay ?? 300,
    phase: "Closed",
    timerVersion: 0,
    exitVersion: 0,
    isHoldingContent: false,
    isPointerOnTrigger: false,
    isPointerOnContent: false,
  }
}

export const isOpen = (model: Model) => model.phase === "Open"

// MESSAGE

export const Message = defineMessageUnion({
  /** The content's Mount finished setting up (portal, position, listeners). */
  CompletedMountContent: {},
  EnteredTrigger: {},
  LeftTrigger: {},
  FocusedTrigger: {},
  BlurredTrigger: {},
  EnteredContent: {},
  LeftContent: {},
  ElapsedOpenDelay: { version: Schema.Number },
  ElapsedCloseDelay: { version: Schema.Number },
  ChangedContentHold: { isHolding: Schema.Boolean },
  DismissedContent: {},
  CompletedExitAnimation: { version: Schema.Number },
})
export type Message = typeof Message.Type

// COMMAND

export const WaitOpenDelay = Command.define("WaitHoverCardOpenDelay", {
  args: { version: Schema.Number, delay: Schema.Number },
  messages: [Message.ElapsedOpenDelay],
  execute: ({ version, delay }) => Effect.sleep(Duration.millis(delay)).pipe(Effect.as(Message.ElapsedOpenDelay({ version }))),
})

export const WaitCloseDelay = Command.define("WaitHoverCardCloseDelay", {
  args: { version: Schema.Number, delay: Schema.Number },
  messages: [Message.ElapsedCloseDelay],
  execute: ({ version, delay }) => Effect.sleep(Duration.millis(delay)).pipe(Effect.as(Message.ElapsedCloseDelay({ version }))),
})

export const WaitForExitAnimation = Command.define("WaitForHoverCardExitAnimation", {
  args: { id: Schema.String, version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ id, version }) =>
    waitForExitAnimation(() => document.getElementById(contentId(id))).pipe(Effect.as(Message.CompletedExitAnimation({ version }))),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

// Radix's handleOpen: cancel a pending close, start the open delay.
function scheduleOpen(model: Model): UpdateReturn {
  const version = Number.increment(model.timerVersion)
  return { model: modifyFields(model, { timerVersion: () => version }), commands: [WaitOpenDelay({ version, delay: model.openDelay })] }
}

// Radix's handleClose: cancel a pending open, and unless text is held in the
// card, start the close delay.
function scheduleClose(model: Model): UpdateReturn {
  const version = Number.increment(model.timerVersion)
  const next = modifyFields(model, { timerVersion: () => version })
  if (model.isHoldingContent) return { model: next }
  return { model: next, commands: [WaitCloseDelay({ version, delay: model.closeDelay })] }
}

/** Closes the card now (Radix's onDismiss), with the exit fade. */
export function close(model: Model): UpdateReturn {
  if (model.phase !== "Open") return { model }
  const exitVersion = Number.increment(model.exitVersion)
  return {
    model: modifyFields(model, { phase: () => "Closing" as const, exitVersion: () => exitVersion, timerVersion: Number.increment }),
    commands: [WaitForExitAnimation({ id: model.id, version: exitVersion })],
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedMountContent: () => ({ model }),
    EnteredTrigger: () => scheduleOpen(modifyFields(model, { isPointerOnTrigger: () => true })),
    LeftTrigger: () => scheduleClose(modifyFields(model, { isPointerOnTrigger: () => false })),
    FocusedTrigger: () => scheduleOpen(model),
    BlurredTrigger: () => scheduleClose(model),
    EnteredContent: () => scheduleOpen(modifyFields(model, { isPointerOnContent: () => true })),
    LeftContent: () => scheduleClose(modifyFields(model, { isPointerOnContent: () => false })),
    ElapsedOpenDelay: ({ version }) =>
      version === model.timerVersion && model.phase !== "Open"
        ? { model: modifyFields(model, { phase: () => "Open" as const, exitVersion: Number.increment }) }
        : { model },
    ElapsedCloseDelay: ({ version }) => (version === model.timerVersion ? close(model) : { model }),
    ChangedContentHold: ({ isHolding }) => ({ model: modifyFields(model, { isHoldingContent: () => isHolding }) }),
    DismissedContent: () => close(model),
    CompletedExitAnimation: ({ version }) =>
      version === model.exitVersion && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const, isHoldingContent: () => false, isPointerOnContent: () => false }) }
        : { model },
  })

// MOUNT

let originalBodyUserSelect = ""

/**
 * On the popper wrapper: portal, position, dismissal, the text-selection
 * hold, and the card's tabbables out of the tab order.
 */
export const HoverCardContent = Mount.defineStream("HoverCardContent", {
  args: {
    id: Schema.String,
    side: Schema.String,
    align: Schema.String,
    sideOffset: Schema.Number,
    alignOffset: Schema.Number,
  },
  messages: [Message.CompletedMountContent, Message.DismissedContent, Message.ChangedContentHold],
  execute: ({ element, id, side, align, sideOffset, alignOffset }) =>
    domStream<typeof Message.CompletedMountContent.Type | typeof Message.DismissedContent.Type | typeof Message.ChangedContentHold.Type>((emit) => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const trigger = document.querySelector<HTMLElement>(`[data-hover-card-trigger="${CSS.escape(id)}"]`)
      const cleanups: Array<() => void> = []

      cleanups.push(portalToBody(wrapper))
      if (trigger) {
        cleanups.push(placePopper(wrapper, content, trigger, {
          side: side as Side,
          align: align as Align,
          sideOffset,
          alignOffset,
          avoidCollisions: true,
          collisionPadding: 0,
        }))
      }
      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: false,
        shouldDismiss: ({ reason }) => reason !== "focus-outside",
        onDismiss: () => emit(Message.DismissedContent()),
      }))

      // Radix sets tabindex -1 on every tabbable in the card, after each render.
      const untab = () => {
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT, {
          acceptNode: (node) => ((node as HTMLElement).tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
        })
        const nodes: HTMLElement[] = []
        while (walker.nextNode()) nodes.push(walker.currentNode as HTMLElement)
        nodes.forEach((node) => node.setAttribute("tabindex", "-1"))
      }
      untab()
      const observer = new MutationObserver(untab)
      observer.observe(content, { childList: true, subtree: true })
      cleanups.push(() => observer.disconnect())

      // A press in the card contains text selection to it, and a selection
      // left behind keeps the card open.
      const body = document.body
      let containing = false
      const contain = (on: boolean) => {
        if (on === containing) return
        containing = on
        if (on) {
          originalBodyUserSelect = body.style.userSelect || body.style.webkitUserSelect
          body.style.userSelect = "none"
          body.style.webkitUserSelect = "none"
          content.style.userSelect = "text"
          content.style.webkitUserSelect = "text"
        } else {
          body.style.userSelect = originalBodyUserSelect
          body.style.webkitUserSelect = originalBodyUserSelect
          content.style.removeProperty("user-select")
          content.style.removeProperty("-webkit-user-select")
        }
      }
      const handlePointerDown = (event: PointerEvent) => {
        if (content.contains(event.target as Node)) contain(true)
        emit(Message.ChangedContentHold({ isHolding: true }))
      }
      const handlePointerUp = () => {
        contain(false)
        setTimeout(() => {
          const hasSelection = document.getSelection()?.toString() !== ""
          emit(Message.ChangedContentHold({ isHolding: hasSelection }))
        })
      }
      content.addEventListener("pointerdown", handlePointerDown)
      document.addEventListener("pointerup", handlePointerUp)
      cleanups.push(() => {
        content.removeEventListener("pointerdown", handlePointerDown)
        document.removeEventListener("pointerup", handlePointerUp)
        contain(false)
      })

      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// VIEW

export interface RenderInfo {
  /** Spread onto the trigger element (Radix's HoverCardTrigger asChild). */
  trigger: ReadonlyArray<ChildAttribute>
  /** The card, or nothing while closed. Render it anywhere in the markup. */
  portal: Html
  isOpen: boolean
}

export interface ViewInputs {
  content: () => ReadonlyArray<Child>
  toView: (render: RenderInfo) => Html
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  className?: string
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const open = model.phase === "Open"
  const state = open ? "open" : "closed"
  const side = inputs.side ?? "bottom"
  const align = inputs.align ?? "center"
  const exceptTouch = (message: Message) => (pointerType: string) => (pointerType === "touch" ? Option.none() : Option.some(message))

  const trigger = childAttributes([
    h.DataAttribute("hover-card-trigger", model.id),
    h.DataAttribute("state", state),
    h.OnPointerMove((_x, _y, pointerType) =>
      pointerType === "touch" || model.isPointerOnTrigger ? Option.none() : Option.some(Message.EnteredTrigger())),
    h.OnPointerLeave(exceptTouch(Message.LeftTrigger())),
    h.OnFocus(Message.FocusedTrigger()),
    h.OnBlur(Message.BlurredTrigger()),
  ])

  const portal = model.phase !== "Closed"
    ? h.keyed("div")(`${model.id}-hover-card`, [
      h.DataAttribute("radix-popper-content-wrapper", ""),
      h.Style(POPPER_WRAPPER_INITIAL_STYLE),
      h.OnMount(HoverCardContent({ id: model.id, side, align, sideOffset: inputs.sideOffset ?? 4, alignOffset: inputs.alignOffset ?? 0 })),
    ], [
      h.div([
        h.DataAttribute("side", side),
        h.DataAttribute("align", align),
        h.DataAttribute("state", state),
        h.Id(contentId(model.id)),
        h.Class(cn("z-50 rounded-md border border-border bg-card text-card-foreground p-4 shadow-md outline-none floating-surface", inputs.className)),
        h.Style({
          "--radix-hover-card-content-transform-origin": "var(--radix-popper-transform-origin)",
          "--radix-hover-card-content-available-width": "var(--radix-popper-available-width)",
          "--radix-hover-card-content-available-height": "var(--radix-popper-available-height)",
          "--radix-hover-card-trigger-width": "var(--radix-popper-anchor-width)",
          "--radix-hover-card-trigger-height": "var(--radix-popper-anchor-height)",
        }),
        h.OnPointerMove((_x, _y, pointerType) =>
          pointerType === "touch" || model.isPointerOnContent ? Option.none() : Option.some(Message.EnteredContent())),
        h.OnPointerLeave(exceptTouch(Message.LeftContent())),
      ], inputs.content()),
    ])
    : null

  return inputs.toView({ trigger, portal, isOpen: open })
})
