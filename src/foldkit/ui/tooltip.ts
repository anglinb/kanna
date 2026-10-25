import { Effect, Number, Option, Schema } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import { childAttributes, type ChildAttribute, type Html, type HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { cn } from "../../client/lib/utils"
import type { Child } from "./attributes"
import { kbd, kbdGroup } from "./kbd"
import { graceArea, isPointInPolygon, type Polygon } from "./overlay/grace-area"
import { registerLayer } from "./overlay/layer"
import { placePopper, POPPER_WRAPPER_INITIAL_STYLE, type Align, type Side } from "./overlay/popper"
import { portalToBody } from "./overlay/portal"
import { waitForExitAnimation } from "./overlay/presence"
import { domStream } from "./overlay/stream"
import { VISUALLY_HIDDEN_STYLE } from "./overlay/visually-hidden"

/**
 * `<Tooltip>` / `<TooltipTrigger asChild>` / `<TooltipContent>` and the
 * `HotkeyTooltip` variant (src/client/components/ui/tooltip.tsx), with
 * Radix's behaviour and DOM:
 *
 *  - Pointer moving onto the trigger opens after `delayDuration` (700ms, the
 *    app's TooltipProvider default), or at once while another tooltip closed
 *    less than 300ms ago (the provider's skip delay). Focus opens at once,
 *    unless the focus came from a pointer press. Pointer down, click, blur,
 *    Escape, a scroll of an ancestor, or another tooltip opening close it.
 *  - The content is hoverable: leaving the trigger toward it keeps it open
 *    across the gap (Radix's grace area).
 *  - `data-state` on trigger and content is `closed`, `delayed-open` or
 *    `instant-open`; the trigger gets `aria-describedby` while open, pointing
 *    at a visually hidden `role="tooltip"` copy of the content.
 *  - The content renders in a popper wrapper at the end of <body>, positioned
 *    by Floating UI exactly as Radix does (side, align, offsets, collisions),
 *    and fades out (`data-state="closed"`) before it unmounts.
 *
 * The page-wide state Radix's TooltipProvider holds (skip delay, pointer in
 * transit) lives in this module, touched only by Commands and Mounts: one
 * provider per page, as the app has.
 *
 * Wiring (one Model per trigger, like one <Tooltip> per trigger in React):
 *   Model:   fetchTooltip: Tooltip.Model                  init: Tooltip.init({ id: "fetch", delayDuration: 0 })
 *   Message: GotFetchTooltipMessage: { message: Tooltip.Message }
 *   update:  GotFetchTooltipMessage: ({ message }) => foldFetchTooltip(model, message)   (Update.foldChild)
 *   view:
 *     h.submodel({
 *       slotId: "fetch-tooltip", model: model.fetchTooltip, view: Tooltip.view,
 *       viewInputs: {
 *         content: () => ["Fetched 2m ago"],
 *         toView: ({ trigger, portal }) =>
 *           button({ variant: "ghost", attributes: [...trigger, h.AriaLabel("Fetch"), h.OnClick(ClickedFetch())] }, [icon, portal], h),
 *       },
 *       toParentMessage: (message) => GotFetchTooltipMessage({ message }),
 *     })
 *
 * `portal` must be rendered somewhere in `toView`'s markup (the trigger's
 * last child is the convention); it moves itself to <body> when it mounts.
 */

const TOOLTIP_OPEN_EVENT = "tooltip.open"
const DEFAULT_DELAY_DURATION = 700
const SKIP_DELAY_DURATION = 300

export const HOTKEY_TOOLTIP_CONTENT_CLASSNAME =
  "z-50 overflow-hidden rounded-md border border-border backdrop-blur-md p-0.5 text-[11px] font-medium text-card-foreground shadow-sm"

const TOOLTIP_CONTENT_CLASSNAME = "z-50 overflow-hidden rounded-md bg-card text-card-foreground border border-border px-3 py-1.5 text-xs"

// PROVIDER (page-wide, Radix's TooltipProvider refs)

const provider = {
  isOpenDelayed: true,
  skipDelayTimer: 0,
  isPointerInTransit: false,
  /**
   * The provider as the latest pointermove found it, taken before any element
   * sees the event. Radix decides in the trigger's pointermove handler; here
   * the decision runs in a Command a moment later, so it reads this snapshot
   * rather than the live refs another listener may have changed since.
   */
  atLastPointerMove: { isOpenDelayed: true, isPointerInTransit: false },
  isWatchingPointer: false,
}

function watchPointer() {
  if (provider.isWatchingPointer) return
  provider.isWatchingPointer = true
  document.addEventListener("pointermove", () => {
    provider.atLastPointerMove = { isOpenDelayed: provider.isOpenDelayed, isPointerInTransit: provider.isPointerInTransit }
  }, { capture: true })
}

// MODEL

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

export const OpenTiming = Schema.Literals(["Instant", "Delayed", "InTransit"])
export type OpenTiming = typeof OpenTiming.Type

export const Model = Schema.Struct({
  id: Schema.String,
  delayDuration: Schema.Number,
  phase: Phase,
  wasOpenDelayed: Schema.Boolean,
  /** Radix's hasPointerMoveOpenedRef: one open per pointer visit. */
  hasPointerMoveOpened: Schema.Boolean,
  /** A press on the trigger: the focus it causes doesn't open the tooltip. */
  isPointerDown: Schema.Boolean,
  /** Radix's open timer: bumped to cancel a pending open. */
  timerVersion: Schema.Number,
  /** Bumped by every close, so an older exit wait is ignored. */
  exitVersion: Schema.Number,
})
export type Model = typeof Model.Type

export function init(config: { id: string; delayDuration?: number }): Model {
  return {
    id: config.id,
    delayDuration: config.delayDuration ?? DEFAULT_DELAY_DURATION,
    phase: "Closed",
    wasOpenDelayed: false,
    hasPointerMoveOpened: false,
    isPointerDown: false,
    timerVersion: 0,
    exitVersion: 0,
  }
}

export const contentId = (id: string) => `${id}-tooltip-content`
export const isOpen = (model: Model) => model.phase === "Open"

export function stateAttribute(model: Model) {
  return model.phase === "Open" ? (model.wasOpenDelayed ? "delayed-open" : "instant-open") : "closed"
}

// MESSAGE

export const Message = defineMessageUnion({
  /** The content's Mount finished setting up (portal, position, listeners). */
  CompletedMountContent: {},
  MovedPointerOnTrigger: {},
  LeftTrigger: {},
  PressedTrigger: {},
  FocusedTrigger: {},
  BlurredTrigger: {},
  ClickedTrigger: {},
  ResolvedOpenTiming: { version: Schema.Number, timing: OpenTiming },
  DismissedContent: {},
  CompletedAnnounceOpen: {},
  CompletedAnnounceClose: {},
  CompletedExitAnimation: { version: Schema.Number },
})
export type Message = typeof Message.Type

// COMMAND

/**
 * A pointer visit's open: skipped while the pointer is crossing to another
 * tooltip's content, at once within the provider's skip delay, otherwise
 * after `delayDuration` (Radix's onTriggerEnter).
 */
export const ResolveOpenTiming = Command.define("ResolveTooltipOpenTiming", {
  args: { version: Schema.Number, delayDuration: Schema.Number },
  messages: [Message.ResolvedOpenTiming],
  execute: ({ version, delayDuration }) =>
    Effect.suspend(() => {
      const { isOpenDelayed, isPointerInTransit } = provider.isWatchingPointer
        ? provider.atLastPointerMove
        : { isOpenDelayed: provider.isOpenDelayed, isPointerInTransit: provider.isPointerInTransit }
      if (isPointerInTransit) return Effect.succeed(Message.ResolvedOpenTiming({ version, timing: "InTransit" }))
      if (!isOpenDelayed) return Effect.succeed(Message.ResolvedOpenTiming({ version, timing: "Instant" }))
      return Effect.sleep(delayDuration).pipe(Effect.as(Message.ResolvedOpenTiming({ version, timing: "Delayed" })))
    }),
})

/** Tells the provider and every other tooltip (Radix's too) that this one opened. */
export const AnnounceOpen = Command.define("AnnounceTooltipOpen", {
  args: { id: Schema.String },
  messages: [Message.CompletedAnnounceOpen],
  execute: ({ id }) =>
    Effect.sync(() => {
      window.clearTimeout(provider.skipDelayTimer)
      provider.isOpenDelayed = false
      document.dispatchEvent(new CustomEvent(TOOLTIP_OPEN_EVENT, { detail: { id } }))
      return Message.CompletedAnnounceOpen()
    }),
})

/** Starts the provider's skip delay: a tooltip opened within 300ms opens at once. */
export const AnnounceClose = Command.define("AnnounceTooltipClose", {
  messages: [Message.CompletedAnnounceClose],
  execute: Effect.sync(() => {
    window.clearTimeout(provider.skipDelayTimer)
    provider.skipDelayTimer = window.setTimeout(() => {
      provider.isOpenDelayed = true
    }, SKIP_DELAY_DURATION)
    return Message.CompletedAnnounceClose()
  }),
})

export const WaitForExitAnimation = Command.define("WaitForTooltipExitAnimation", {
  args: { id: Schema.String, version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ id, version }) =>
    waitForExitAnimation(() => document.getElementById(contentId(id))?.parentElement ?? null).pipe(
      Effect.as(Message.CompletedExitAnimation({ version })),
    ),
})

// UPDATE

// No OutMessage: no caller reacts to a tooltip opening (React's onOpenChange
// is unused on tooltips), so parents fold it with no handler to write.
type UpdateReturn = Update.Return<Model, Message>

// Radix's handleOpen: cancels a pending open; announces only a real change.
function open(model: Model, wasOpenDelayed: boolean): UpdateReturn {
  const cancelled = modifyFields(model, { timerVersion: Number.increment })
  if (model.phase === "Open") return { model: cancelled }
  return {
    model: modifyFields(cancelled, { phase: () => "Open" as const, wasOpenDelayed: () => wasOpenDelayed }),
    commands: [AnnounceOpen({ id: model.id })],
  }
}

// Radix's handleClose: cancels a pending open; a real close fades out.
function close(model: Model): UpdateReturn {
  const cancelled = modifyFields(model, { timerVersion: Number.increment })
  if (model.phase !== "Open") return { model: cancelled }
  const exitVersion = Number.increment(model.exitVersion)
  return {
    model: modifyFields(cancelled, { phase: () => "Closing" as const, exitVersion: () => exitVersion }),
    commands: [AnnounceClose(), WaitForExitAnimation({ id: model.id, version: exitVersion })],
  }
}

/** Closes the tooltip from the parent (Radix's controlled `open={false}`). */
export const hide = (model: Model): UpdateReturn => close(model)

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedMountContent: () => ({ model }),
    MovedPointerOnTrigger: () => {
      if (model.hasPointerMoveOpened) return { model }
      const version = Number.increment(model.timerVersion)
      return {
        model: modifyFields(model, { hasPointerMoveOpened: () => true, timerVersion: () => version }),
        commands: [ResolveOpenTiming({ version, delayDuration: model.delayDuration })],
      }
    },
    // Hoverable content: leaving the trigger only cancels a pending open; the
    // content's grace area decides whether an open tooltip closes.
    LeftTrigger: () => ({
      model: modifyFields(model, { hasPointerMoveOpened: () => false, isPointerDown: () => false, timerVersion: Number.increment }),
    }),
    PressedTrigger: () => {
      const pressed = modifyFields(model, { isPointerDown: () => true })
      return model.phase === "Open" ? close(pressed) : { model: pressed }
    },
    FocusedTrigger: () => (model.isPointerDown ? { model } : open(model, false)),
    BlurredTrigger: () => close(model),
    ClickedTrigger: () => close(modifyFields(model, { isPointerDown: () => false })),
    ResolvedOpenTiming: ({ version, timing }) => {
      if (version !== model.timerVersion) return { model }
      if (timing === "InTransit") return { model: modifyFields(model, { hasPointerMoveOpened: () => false }) }
      return open(model, timing === "Delayed")
    },
    DismissedContent: () => close(model),
    CompletedAnnounceOpen: () => ({ model }),
    CompletedAnnounceClose: () => ({ model }),
    CompletedExitAnimation: ({ version }) =>
      version === model.exitVersion && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const }) }
        : { model },
  })

// MOUNT

/**
 * On the popper wrapper: moves it to <body>, positions it, and reports what
 * closes the tooltip from outside the trigger (Escape, a pointerdown outside,
 * an ancestor scrolling, another tooltip opening, the pointer leaving the
 * grace area between trigger and content).
 */
export const TooltipContent = Mount.defineStream("TooltipContent", {
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
      const trigger = document.querySelector<HTMLElement>(`[data-tooltip-trigger="${CSS.escape(id)}"]`)
      const cleanups: Array<() => void> = []
      const dismiss = () => emit(Message.DismissedContent())
      watchPointer()

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
        onDismiss: dismiss,
      }))

      const handleOtherOpen = (event: Event) => {
        if ((event as CustomEvent<{ id?: string } | null>).detail?.id !== id) dismiss()
      }
      document.addEventListener(TOOLTIP_OPEN_EVENT, handleOtherOpen)
      cleanups.push(() => document.removeEventListener(TOOLTIP_OPEN_EVENT, handleOtherOpen))

      if (trigger) {
        const handleScroll = (event: Event) => {
          const target = event.target
          if (target instanceof Node && target.contains(trigger)) dismiss()
        }
        window.addEventListener("scroll", handleScroll, { capture: true })
        cleanups.push(() => window.removeEventListener("scroll", handleScroll, { capture: true }))

        // Hoverable content: the hull between where the pointer left one and
        // the other's rectangle keeps the tooltip open while it crosses.
        // As Radix: the area is React state, and the document listener that
        // checks it is registered by an effect after the re-render, a task
        // later. So the pointermove that comes with the leave itself is never
        // checked; the next one is.
        let polygon: Polygon | null = null
        let listening = false
        let listenTimer = 0
        const setGrace = (next: Polygon | null) => {
          polygon = next
          provider.isPointerInTransit = next !== null
          window.clearTimeout(listenTimer)
          if (next === null) {
            if (listening) document.removeEventListener("pointermove", trackGrace)
            listening = false
          } else if (!listening) {
            listenTimer = window.setTimeout(() => {
              listening = true
              document.addEventListener("pointermove", trackGrace)
            }, 0)
          }
        }
        const leaveTrigger = (event: PointerEvent) => setGrace(graceArea({ x: event.clientX, y: event.clientY }, trigger, content))
        const leaveContent = (event: PointerEvent) => setGrace(graceArea({ x: event.clientX, y: event.clientY }, content, trigger))
        const trackGrace = (event: PointerEvent) => {
          if (!polygon) return
          const target = event.target as Node | null
          const entered = (target && trigger.contains(target)) || (target && content.contains(target))
          if (entered) {
            setGrace(null)
          } else if (!isPointInPolygon({ x: event.clientX, y: event.clientY }, polygon)) {
            setGrace(null)
            dismiss()
          }
        }
        trigger.addEventListener("pointerleave", leaveTrigger)
        content.addEventListener("pointerleave", leaveContent)
        cleanups.push(() => {
          trigger.removeEventListener("pointerleave", leaveTrigger)
          content.removeEventListener("pointerleave", leaveContent)
          setGrace(null)
        })
      }

      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// VIEW

export interface RenderInfo {
  /** Spread onto the trigger element (Radix's TooltipTrigger asChild). */
  trigger: ReadonlyArray<ChildAttribute>
  /** The content, or nothing while closed. Render it anywhere in the markup. */
  portal: Html
  isOpen: boolean
}

export interface ViewInputs {
  /** The tooltip's text or markup. Rendered twice: visibly and as the hidden role="tooltip" copy. */
  content: () => ReadonlyArray<Child>
  toView: (render: RenderInfo) => Html
  side?: Side
  align?: Align
  sideOffset?: number
  alignOffset?: number
  className?: string
  /** Radix's `aria-label` on the content: the hidden copy reads this instead. */
  ariaLabel?: string
  /** `<StillTooltips>`: no entrance or exit motion. */
  still?: boolean
  /** `HotkeyTooltipContent`'s styling (use `hotkeyContent` for its children). */
  variant?: "default" | "hotkey"
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const state = stateAttribute(model)
  const open = model.phase === "Open"
  const rendered = model.phase !== "Closed"
  const side = inputs.side ?? "top"
  const align = inputs.align ?? "center"

  const trigger = childAttributes([
    h.DataAttribute("tooltip-trigger", model.id),
    h.DataAttribute("state", state),
    ...(open ? [h.AriaDescribedBy(contentId(model.id))] : []),
    h.OnPointerMove((_x, _y, pointerType) =>
      pointerType === "touch" || model.hasPointerMoveOpened ? Option.none() : Option.some(Message.MovedPointerOnTrigger())),
    h.OnPointerLeave(() => Option.some(Message.LeftTrigger())),
    h.OnPointerDown(() => Option.some(Message.PressedTrigger())),
    h.OnFocus(Message.FocusedTrigger()),
    h.OnBlur(Message.BlurredTrigger()),
    h.OnClick(Message.ClickedTrigger()),
  ])

  const portal = rendered
    ? h.keyed("div")(`${model.id}-tooltip`, [
      h.DataAttribute("radix-popper-content-wrapper", ""),
      h.Style(POPPER_WRAPPER_INITIAL_STYLE),
      h.OnMount(TooltipContent({
        id: model.id,
        side,
        align,
        sideOffset: inputs.sideOffset ?? 4,
        alignOffset: inputs.alignOffset ?? 0,
      })),
    ], [
      h.div([
        h.DataAttribute("side", side),
        h.DataAttribute("align", align),
        h.DataAttribute("state", state),
        h.Class(cn(
          inputs.variant === "hotkey" ? HOTKEY_TOOLTIP_CONTENT_CLASSNAME : TOOLTIP_CONTENT_CLASSNAME,
          inputs.still ? null : "floating-surface",
          inputs.className,
        )),
        h.Style({
          "--radix-tooltip-content-transform-origin": "var(--radix-popper-transform-origin)",
          "--radix-tooltip-content-available-width": "var(--radix-popper-available-width)",
          "--radix-tooltip-content-available-height": "var(--radix-popper-available-height)",
          "--radix-tooltip-trigger-width": "var(--radix-popper-anchor-width)",
          "--radix-tooltip-trigger-height": "var(--radix-popper-anchor-height)",
        }),
      ], [
        ...inputs.content(),
        h.span(
          [h.Id(contentId(model.id)), h.Role("tooltip"), h.Style(VISUALLY_HIDDEN_STYLE)],
          inputs.ariaLabel !== undefined ? [inputs.ariaLabel] : inputs.content(),
        ),
      ]),
    ])
    : null

  return inputs.toView({ trigger, portal, isOpen: open })
})

// HOTKEY CONTENT

export function formatHotkeyLabel(label: string) {
  return label.toUpperCase()
}

/**
 * `HotkeyTooltipContent`'s children: the first shortcut as keys, or the
 * label in capitals. Pass as `content` with `variant: "hotkey"`.
 *
 *   content: Tooltip.hotkeyContent({ shortcut: "cmd+j" }, h)
 */
export function hotkeyContent<Message>(
  options: { shortcut?: string | ReadonlyArray<string>; label?: string },
  h: HtmlBuilder<Message>,
): () => ReadonlyArray<Child> {
  const firstShortcut = options.shortcut === undefined
    ? null
    : typeof options.shortcut === "string"
      ? options.shortcut
      : options.shortcut[0] ?? null
  return () => firstShortcut
    ? [kbdGroup({}, firstShortcut.split("+").map((key) => kbd({}, [formatHotkeyLabel(key)], h)), h)]
    : [h.span([], [formatHotkeyLabel(options.label ?? "")])]
}
