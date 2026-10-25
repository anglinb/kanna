import { Effect, Number, Schema } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { childAttributes, type ChildAttribute, type Html } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE, RESTORE_CHAT_INPUT_FOCUS_EVENT } from "../../client/app/chatFocusPolicy"
import { cn } from "../../client/lib/utils"
import type { Child } from "./attributes"
import { installFocusGuards, installFocusScope } from "./overlay/focus"
import { registerLayer } from "./overlay/layer"
import { placePopper, POPPER_WRAPPER_INITIAL_STYLE, type Align, type Side } from "./overlay/popper"
import { portalToBody } from "./overlay/portal"
import { waitForExitAnimation } from "./overlay/presence"
import { domStream } from "./overlay/stream"

/**
 * `<Popover>` / `<PopoverTrigger asChild>` / `<PopoverContent>`
 * (src/client/components/ui/popover.tsx): Radix's non-modal popover.
 *
 *  - The trigger toggles it; it carries `aria-haspopup="dialog"`,
 *    `aria-expanded`, `aria-controls` and `data-state`.
 *  - The content is a `role="dialog"` panel at the end of <body>, placed by
 *    Floating UI as Radix places it (bottom, centred, 4px out by default).
 *    It takes focus when it opens (its first tabbable, else itself) and Tab
 *    loops inside it.
 *  - Escape, a pointerdown outside (except on the trigger, which toggles),
 *    or focus moving out closes it. Closing hands focus back the way the app's
 *    PopoverContent does: no return to the trigger, a
 *    `kanna:restore-chat-input-focus` event instead.
 *  - It fades out (`data-state="closed"`) before it unmounts.
 *
 * Wiring:
 *   Model:   filter: Popover.Model                    init: Popover.init({ id: "projects-filter" })
 *   Message: GotFilterMessage: { message: Popover.Message }
 *   update:  GotFilterMessage: ({ message }) => foldFilter(model, message)       (Update.foldChild)
 *            ChoseFilter: ...then Update.foldChildStep({ update: Popover.close, ... }) to close it
 *   view:
 *     h.submodel({ slotId: "projects-filter", model: model.filter, view: Popover.view,
 *       viewInputs: {
 *         align: "end", sideOffset: 8, className: "w-60 overflow-hidden p-0",
 *         content: () => [filterList],
 *         toView: ({ trigger, portal }) => h.button([...trigger, h.AriaLabel("Filter projects")], [icon, portal]),
 *       },
 *       toParentMessage: (message) => GotFilterMessage({ message }) })
 */

export const contentId = (id: string) => `${id}-popover-content`

// MODEL

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

export const Model = Schema.Struct({
  id: Schema.String,
  phase: Phase,
  version: Schema.Number,
})
export type Model = typeof Model.Type

export function init(config: { id: string }): Model {
  return { id: config.id, phase: "Closed", version: 0 }
}

export const isOpen = (model: Model) => model.phase === "Open"

// MESSAGE

export const Message = defineMessageUnion({
  /** The content's Mount finished setting up (portal, position, listeners). */
  CompletedMountContent: {},
  ClickedTrigger: {},
  DismissedContent: {},
  CompletedExitAnimation: { version: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Opened: {},
  Closed: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const WaitForExitAnimation = Command.define("WaitForPopoverExitAnimation", {
  args: { id: Schema.String, version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ id, version }) =>
    waitForExitAnimation(() => document.getElementById(contentId(id))).pipe(Effect.as(Message.CompletedExitAnimation({ version }))),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

/** Opens the popover from the parent. */
export function open(model: Model): UpdateReturn {
  if (model.phase === "Open") return { model }
  return {
    model: modifyFields(model, { phase: () => "Open" as const, version: Number.increment }),
    outMessage: OutMessage.Opened(),
  }
}

/** Closes the popover from the parent (the app's `close()` render prop, `setOpen(false)`). */
export function close(model: Model): UpdateReturn {
  if (model.phase !== "Open") return { model }
  const version = Number.increment(model.version)
  return {
    model: modifyFields(model, { phase: () => "Closing" as const, version: () => version }),
    commands: [WaitForExitAnimation({ id: model.id, version })],
    outMessage: OutMessage.Closed(),
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedMountContent: () => ({ model }),
    ClickedTrigger: () => (model.phase === "Open" ? close(model) : open(model)),
    DismissedContent: () => close(model),
    CompletedExitAnimation: ({ version }) =>
      version === model.version && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const }) }
        : { model },
  })

// MOUNT

/** On the popper wrapper: portal, position, dismissal, focus. */
export const PopoverContent = Mount.defineStream("PopoverContent", {
  args: {
    id: Schema.String,
    side: Schema.String,
    align: Schema.String,
    sideOffset: Schema.Number,
    alignOffset: Schema.Number,
  },
  messages: [Message.CompletedMountContent, Message.DismissedContent],
  execute: ({ element, id, side, align, sideOffset, alignOffset }) =>
    domStream<typeof Message.CompletedMountContent.Type | typeof Message.DismissedContent.Type>((emit) => {
      const wrapper = element as HTMLElement
      const content = wrapper.firstElementChild as HTMLElement
      const trigger = document.querySelector<HTMLElement>(`[data-popover-trigger="${CSS.escape(id)}"]`)
      const cleanups: Array<() => void> = []
      // Radix's non-modal content: a pointerdown outside also ignores the
      // focus moving out in its wake (it's already closing).
      let hasPointerDownOutside = false

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
        shouldDismiss: ({ reason, event }) => {
          if (reason === "pointer-down-outside") hasPointerDownOutside = true
          const target = event.target
          if (trigger && target instanceof Node && trigger.contains(target)) return false
          if (reason === "focus-outside" && hasPointerDownOutside) return false
          return true
        },
        onDismiss: () => emit(Message.DismissedContent()),
      }))
      cleanups.push(installFocusScope(content, {
        trapped: false,
        loop: true,
        // The app's PopoverContent: never back to the trigger, the chat
        // input's restore event instead.
        onUnmountAutoFocus: () => {
          window.dispatchEvent(new Event(RESTORE_CHAT_INPUT_FOCUS_EVENT))
          return true
        },
      }))
      cleanups.push(installFocusGuards(document))

      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// VIEW

export interface RenderInfo {
  /** Spread onto the trigger (Radix's PopoverTrigger asChild). */
  trigger: ReadonlyArray<ChildAttribute>
  /** The content, or nothing while closed. Render it anywhere in the markup. */
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

  const trigger = childAttributes([
    h.DataAttribute("popover-trigger", model.id),
    h.Type("button"),
    h.AriaHasPopup("dialog"),
    h.AriaExpanded(open),
    h.AriaControls(contentId(model.id)),
    h.DataAttribute("state", state),
    h.OnClick(Message.ClickedTrigger()),
  ])

  const portal = model.phase !== "Closed"
    ? h.keyed("div")(`${model.id}-popover`, [
      h.DataAttribute("radix-popper-content-wrapper", ""),
      h.Style(POPPER_WRAPPER_INITIAL_STYLE),
      h.OnMount(PopoverContent({ id: model.id, side, align, sideOffset: inputs.sideOffset ?? 4, alignOffset: inputs.alignOffset ?? 0 })),
    ], [
      h.div([
        h.DataAttribute("side", side),
        h.DataAttribute("align", align),
        h.DataAttribute("state", state),
        h.Role("dialog"),
        h.Id(contentId(model.id)),
        h.Tabindex(-1),
        h.Attribute(FOCUS_FALLBACK_IGNORE_ATTRIBUTE, ""),
        h.Class(cn("z-50 w-72 rounded-xl border border-border bg-background p-4 shadow-lg outline-hidden floating-surface", inputs.className)),
        h.Style({
          "--radix-popover-content-transform-origin": "var(--radix-popper-transform-origin)",
          "--radix-popover-content-available-width": "var(--radix-popper-available-width)",
          "--radix-popover-content-available-height": "var(--radix-popper-available-height)",
          "--radix-popover-trigger-width": "var(--radix-popper-anchor-width)",
          "--radix-popover-trigger-height": "var(--radix-popper-anchor-height)",
        }),
      ], inputs.content()),
    ])
    : null

  return inputs.toView({ trigger, portal, isOpen: open })
})
