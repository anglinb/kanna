import { Effect, Number, Schema } from "effect"
import { Command, Mount, Submodel, type Update } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE, RESTORE_CHAT_INPUT_FOCUS_EVENT } from "../../client/app/chatFocusPolicy"
import { cn } from "../../client/lib/utils"
import type { Child, ExtraAttributes } from "./attributes"
import { X } from "./icons"
import { installFocusGuards, installFocusScope } from "./overlay/focus"
import { registerLayer } from "./overlay/layer"
import { hideOthers, lockScroll } from "./overlay/modal"
import { waitForExitAnimation } from "./overlay/presence"
import { domStream } from "./overlay/stream"

/**
 * `<Dialog>` + `<DialogContent>` (src/client/components/ui/dialog.tsx):
 * Radix's modal dialog, with the app's overlay, surface, close button and
 * focus policy.
 *
 * While open, as Radix does: overlay and content are the last children of
 * <body>; everything else is `aria-hidden` and gets no pointer events
 * (`pointer-events: none` on <body>); page scroll is locked
 * (`data-scroll-locked`); focus is trapped in the content, which takes it
 * on open (its first tabbable) and loops Tab. Escape, a click on the overlay
 * and the X button close it. On close focus is not returned to a trigger: the
 * app's DialogContent fires `kanna:restore-chat-input-focus` instead.
 *
 * The dialog has no trigger here (the app opens every dialog from state, as
 * `open={…}` did): the parent folds `Dialog.open` / `Dialog.close`, and
 * hears `Closed` when the user dismissed it (React's `onOpenChange(false)`).
 *
 * Wiring:
 *   Model:   settings: Dialog.Model                       init: Dialog.init({ id: "pair-device" })
 *   Message: GotPairDialogMessage: { message: Dialog.Message }
 *   update:  ClickedPair: () => foldPairDialogOpen(model)                 (Update.foldChildStep, Dialog.open)
 *            GotPairDialogMessage: ({ message }) => foldPairDialog(model, message)  (foldOutMessage: Closed)
 *   view:
 *     h.submodel({ slotId: "pair-device", model: model.pairDialog, view: Dialog.view,
 *       viewInputs: {
 *         size: "md",
 *         content: ({ titleId, descriptionId }) => [
 *           Dialog.dialogHeader({}, [Dialog.dialogTitle({ id: titleId }, ["Pair a device"], h)], h),
 *           Dialog.dialogBody({}, [...], h),
 *         ],
 *       },
 *       toParentMessage: (message) => GotPairDialogMessage({ message }) })
 *
 * The dialog renders where it's embedded and moves itself to <body>; embed it
 * anywhere.
 */

export const contentId = (id: string) => `${id}-dialog-content`
export const titleId = (id: string) => `${id}-dialog-title`
export const descriptionId = (id: string) => `${id}-dialog-description`

// MODEL

export const Phase = Schema.Literals(["Closed", "Open", "Closing"])
export type Phase = typeof Phase.Type

export const Model = Schema.Struct({
  id: Schema.String,
  phase: Phase,
  version: Schema.Number,
})
export type Model = typeof Model.Type

export function init(config: { id: string; isOpen?: boolean }): Model {
  return { id: config.id, phase: config.isOpen ? "Open" : "Closed", version: 0 }
}

export const isOpen = (model: Model) => model.phase === "Open"

// MESSAGE

export const Message = defineMessageUnion({
  /** The content's Mount finished setting up (portal, position, listeners). */
  CompletedMountContent: {},
  ClickedClose: {},
  DismissedContent: {},
  CompletedExitAnimation: { version: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  /** The user closed it: the X, Escape, or a click outside. */
  Closed: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const WaitForExitAnimation = Command.define("WaitForDialogExitAnimation", {
  args: { id: Schema.String, version: Schema.Number },
  messages: [Message.CompletedExitAnimation],
  execute: ({ id, version }) =>
    waitForExitAnimation(() => document.getElementById(contentId(id))).pipe(Effect.as(Message.CompletedExitAnimation({ version }))),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

/** Opens the dialog (React's `open` turning true). */
export function open(model: Model): Update.Return<Model, Message> {
  if (model.phase === "Open") return { model }
  return { model: modifyFields(model, { phase: () => "Open" as const, version: Number.increment }) }
}

/** Closes the dialog from the parent (React's `open` turning false). Emits nothing. */
export function close(model: Model): Update.Return<Model, Message> {
  if (model.phase !== "Open") return { model }
  const version = Number.increment(model.version)
  return {
    model: modifyFields(model, { phase: () => "Closing" as const, version: () => version }),
    commands: [WaitForExitAnimation({ id: model.id, version })],
  }
}

function dismiss(model: Model): UpdateReturn {
  if (model.phase !== "Open") return { model }
  return { ...close(model), outMessage: OutMessage.Closed() }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedMountContent: () => ({ model }),
    ClickedClose: () => dismiss(model),
    DismissedContent: () => dismiss(model),
    CompletedExitAnimation: ({ version }) =>
      version === model.version && model.phase === "Closing"
        ? { model: modifyFields(model, { phase: () => "Closed" as const }) }
        : { model },
  })

// MOUNT

/**
 * On the content. At mount its parent is the overlay (that's how the view
 * nests them): both move to the end of <body>, overlay first, as Radix's
 * two portals put them. Then the modal machinery.
 */
export const DialogContent = Mount.defineStream("DialogContent", {
  args: { id: Schema.String },
  messages: [Message.CompletedMountContent, Message.DismissedContent],
  execute: ({ element }) =>
    domStream<typeof Message.CompletedMountContent.Type | typeof Message.DismissedContent.Type>((emit) => {
      const content = element as HTMLElement
      const overlay = content.parentElement
      const body = content.ownerDocument.body
      const cleanups: Array<() => void> = []

      if (overlay) body.appendChild(overlay)
      body.appendChild(content)
      cleanups.push(() => {
        content.remove()
        overlay?.remove()
      })
      cleanups.push(registerLayer(content, {
        disableOutsidePointerEvents: true,
        shouldDismiss: ({ reason, event }) => {
          if (reason === "focus-outside") return false
          if (reason === "pointer-down-outside" && event instanceof PointerEvent) {
            const isRightClick = event.button === 2 || (event.button === 0 && event.ctrlKey)
            if (isRightClick) return false
          }
          return true
        },
        onDismiss: () => emit(Message.DismissedContent()),
      }))
      cleanups.push(installFocusScope(content, {
        trapped: true,
        loop: true,
        onUnmountAutoFocus: () => {
          window.dispatchEvent(new Event(RESTORE_CHAT_INPUT_FOCUS_EVENT))
          return true
        },
      }))
      cleanups.push(installFocusGuards(content.ownerDocument))
      cleanups.push(hideOthers(content))
      cleanups.push(lockScroll(content.ownerDocument, [content]))

      emit(Message.CompletedMountContent())
      return () => cleanups.reverse().forEach((cleanup) => cleanup())
    }),
})

// VIEW

const sizeClasses = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
}

export interface ContentParts {
  /** For `dialogTitle`: the id the content's aria-labelledby names. */
  titleId: string
  /** For `dialogDescription`: the id the content's aria-describedby names. */
  descriptionId: string
}

export interface ViewInputs {
  content: (parts: ContentParts) => ReadonlyArray<Child>
  size?: "sm" | "md" | "lg"
  className?: string
  /**
   * More attributes on the content (React's DialogContent props, like
   * onKeyDown). Runs in the parent's boundary; wrap handlers with
   * `childAttributes` there so they dispatch to the parent:
   * `contentAttributes: () => childAttributes([h.OnKeyDown(...)])`.
   */
  contentAttributes?: () => ReadonlyArray<ChildAttribute>
}

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  if (model.phase === "Closed") return null
  const state = model.phase === "Open" ? "open" : "closed"
  const parts: ContentParts = { titleId: titleId(model.id), descriptionId: descriptionId(model.id) }
  return h.keyed("div")(`${model.id}-dialog-overlay`, [
    h.DataAttribute("state", state),
    // Entrance in index.css, under "Dialogs".
    h.Class("dialog-overlay fixed inset-0 z-50 bg-black/50"),
    h.Style({ "pointer-events": "auto" }),
  ], [
    h.div([
      h.Role("dialog"),
      h.Id(contentId(model.id)),
      h.AriaDescribedBy(parts.descriptionId),
      h.AriaLabelledBy(parts.titleId),
      h.DataAttribute("state", state),
      h.Attribute(FOCUS_FALLBACK_IGNORE_ATTRIBUTE, ""),
      h.Tabindex(-1),
      h.Class(cn(
        "dialog-surface fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background shadow-xl",
        "max-h-[85vh] flex flex-col",
        sizeClasses[inputs.size ?? "md"],
        inputs.className,
      )),
      ...(inputs.contentAttributes?.() ?? []),
      h.OnMount(DialogContent({ id: model.id })),
    ], [
      ...inputs.content(parts),
      h.button([
        h.Type("button"),
        h.OnClick(Message.ClickedClose()),
        h.Class("absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"),
      ], [
        X({ class: "h-4 w-4" }, h),
        h.span([h.Class("sr-only")], ["Close"]),
      ]),
    ]),
  ])
})

// PARTS (stateless, as in dialog.tsx)

type Block = <Message>(options: { class?: string; attributes?: ExtraAttributes<Message> }, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>) => Html

function block(base: string): Block {
  return (options, children, h) => h.div([h.Class(cn(base, options.class)), ...(options.attributes ?? [])], children)
}

export const dialogHeader = block("shrink-0 flex flex-col space-y-1.5 p-4 border-b border-border")
export const dialogBody = block("flex-1 min-h-0 overflow-y-auto px-4 pb-4 pt-3.5")
export const dialogFooter = block("shrink-0 flex justify-end gap-2 border-t border-border bg-background p-2 rounded-b-xl")

/** `<DialogTitle>`: an h2 with the id the content's aria-labelledby names. */
export function dialogTitle<Message>(
  options: { id: string; class?: string; attributes?: ExtraAttributes<Message> },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  return h.h2([h.Id(options.id), h.Class(cn("text-lg font-medium leading-none tracking-tight", options.class)), ...(options.attributes ?? [])], children)
}

/** `<DialogDescription>`: a p with the id the content's aria-describedby names. */
export function dialogDescription<Message>(
  options: { id: string; class?: string; attributes?: ExtraAttributes<Message> },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  return h.p([h.Id(options.id), h.Class(cn("text-sm text-muted-foreground", options.class)), ...(options.attributes ?? [])], children)
}

type ButtonBlock = <Message>(
  options: { class?: string; type?: "button" | "submit"; disabled?: boolean; attributes?: ExtraAttributes<Message> },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
) => Html

function dialogButton(look: string): ButtonBlock {
  return (options, children, h) =>
    h.button([
      ...(options.type ? [h.Type(options.type)] : []),
      ...(options.disabled ? [h.Disabled(true)] : []),
      h.Class(cn(
        "touch-manipulation inline-flex items-center justify-center whitespace-nowrap cursor-pointer text-sm font-medium transition-colors",
        "rounded-full h-9 px-4",
        look,
        options.class,
      )),
      ...(options.attributes ?? []),
    ], children)
}

export const dialogPrimaryButton = dialogButton(cn(
  "bg-primary text-primary-foreground hover:bg-primary/90",
  "disabled:pointer-events-none disabled:bg-primary/20 disabled:text-primary/60",
))

export const dialogGhostButton = dialogButton(cn(
  "hover:bg-accent dark:hover:bg-card hover:text-accent-foreground text-muted-foreground",
  "disabled:pointer-events-none disabled:text-muted-foreground/50",
))
