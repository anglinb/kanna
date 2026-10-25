import { Schema } from "effect"
import { CustomElement, Mount } from "foldkit"
import type { Attribute, HtmlBuilder } from "foldkit/html"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import * as Recorder from "./recorder"

// The composer's DOM work that follows an element: the event bridge on its
// root, the textarea's focus, size and caret, the waveform's canvas.

// THE EVENT BRIDGE
//
// React's handlers read the event (a key's `repeat`, the pointer's
// modifier keys, the clipboard's files) and decided on `preventDefault`
// from the render's own state. Foldkit's attributes carry neither the
// event nor a way to decide synchronously from it, so the composer's root
// re-dispatches the native events it needs as `kanna-composer-<type>`
// CustomEvents carrying the native event, on the same target, in the same
// tick. Elements listen with `onBridged`, whose handler is made in the view
// (so it closes over this render's state, as React's did) and may call
// `preventDefault` on the native event before it returns its Message.

const BRIDGED_EVENTS = ["keydown", "pointerdown", "mousedown", "click", "paste", "input"] as const
type BridgedType = typeof BRIDGED_EVENTS[number]

interface BridgedEventMap {
  keydown: KeyboardEvent
  pointerdown: PointerEvent
  mousedown: MouseEvent
  click: MouseEvent
  paste: ClipboardEvent
  input: InputEvent
}

const bridgedName = (type: BridgedType) => `kanna-composer-${type}`

export const BridgeComposerEvents = Mount.defineStream("BridgeComposerEvents", {
  messages: [Message.CompletedMountComposer],
  execute: ({ element }) => domStream<typeof Message.CompletedMountComposer.Type>((emit) => {
    const forward = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      target.dispatchEvent(new CustomEvent(bridgedName(event.type as BridgedType), { detail: event, bubbles: true }))
    }
    BRIDGED_EVENTS.forEach((type) => element.addEventListener(type, forward))
    emit(Message.CompletedMountComposer())
    return () => BRIDGED_EVENTS.forEach((type) => element.removeEventListener(type, forward))
  }),
})

// The bridged events, declared the way a custom element's are: that is the
// typed way Foldkit offers to listen for a CustomEvent on an element. No
// element of this tag is ever drawn; only its event factories are used.
const Bridge = CustomElement.define({
  tag: "kanna-composer-bridge",
  properties: {},
  events: {
    "kanna-composer-keydown": Schema.Unknown,
    "kanna-composer-pointerdown": Schema.Unknown,
    "kanna-composer-mousedown": Schema.Unknown,
    "kanna-composer-click": Schema.Unknown,
    "kanna-composer-paste": Schema.Unknown,
    "kanna-composer-input": Schema.Unknown,
  },
})

const BRIDGE_FACTORIES = {
  keydown: "OnKannaComposerKeydown",
  pointerdown: "OnKannaComposerPointerdown",
  mousedown: "OnKannaComposerMousedown",
  click: "OnKannaComposerClick",
  paste: "OnKannaComposerPaste",
  input: "OnKannaComposerInput",
} as const satisfies Record<BridgedType, string>

/**
 * The element's handler for a bridged native event: null leaves the event
 * alone (and says so with `IgnoredKey`); a Message is dispatched.
 */
export function onBridged<Type extends BridgedType>(
  h: HtmlBuilder<Message>,
  type: Type,
  handle: (event: BridgedEventMap[Type]) => Message | null,
): Attribute<Message> {
  const builder = Bridge.withMessage(h)
  return builder[BRIDGE_FACTORIES[type]]((detail: unknown) => handle(detail as BridgedEventMap[Type]) ?? Message.IgnoredKey())
}

// THE TEXTAREA

function autoResize(element: HTMLTextAreaElement) {
  if (element.value.length === 0) {
    element.style.height = ""
    return
  }
  element.style.height = "auto"
  element.style.height = `${element.scrollHeight}px`
}

/**
 * The textarea's own life: focused when it appears (autoFocus, and the
 * effect on `chatId`), sized to its text, and its caret reported as it
 * moves (React's onSelect, which hears selection changes, clicks and keys).
 */
export const TextareaLifecycle = Mount.defineStream("ComposerTextarea", {
  args: { autoFocus: Schema.Boolean },
  messages: [Message.CompletedMountTextarea, Message.MovedCaret],
  execute: ({ element, autoFocus }) => domStream<typeof Message.CompletedMountTextarea.Type | typeof Message.MovedCaret.Type>((emit) => {
    const textarea = element as HTMLTextAreaElement
    if (autoFocus) textarea.focus()
    autoResize(textarea)
    emit(Message.CompletedMountTextarea())

    let lastCaret = textarea.selectionStart ?? 0
    const reportCaret = () => {
      if (document.activeElement !== textarea) return
      const caret = textarea.selectionStart ?? 0
      if (caret === lastCaret) return
      lastCaret = caret
      emit(Message.MovedCaret({ caret }))
    }
    const handleResize = () => autoResize(textarea)
    const caretEvents = ["select", "keyup", "mouseup", "focus"] as const
    caretEvents.forEach((type) => textarea.addEventListener(type, reportCaret))
    document.addEventListener("selectionchange", reportCaret)
    // A value written by the composer moves the caret without a select event.
    textarea.addEventListener("input", () => {
      lastCaret = textarea.selectionStart ?? 0
    })
    window.addEventListener("resize", handleResize)
    return () => {
      caretEvents.forEach((type) => textarea.removeEventListener(type, reportCaret))
      document.removeEventListener("selectionchange", reportCaret)
      window.removeEventListener("resize", handleResize)
    }
  }),
})

// THE WAVEFORM (RecordingWaveform)

/**
 * Auto-scrolling live volume bars shown in place of the textarea while
 * recording. A direct port of the iOS RecordingLevelsView: 3px rounded
 * bars with 2px gaps, newest sample at the right edge, centered on the
 * midline.
 */
const WAVE_BAR_WIDTH = 3
const WAVE_BAR_SPACING = 2
const WAVE_MIN_BAR_HEIGHT = 3

function drawWaveform(canvas: HTMLCanvasElement, levels: readonly number[]) {
  const dpr = window.devicePixelRatio || 1
  const { width, height } = canvas.getBoundingClientRect()
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = window.getComputedStyle(canvas).color

  const step = WAVE_BAR_WIDTH + WAVE_BAR_SPACING
  const capacity = Math.max(1, Math.floor(width / step))
  const visible = levels.slice(-capacity)
  const midY = height / 2

  let x = width - WAVE_BAR_WIDTH
  for (let i = visible.length - 1; i >= 0; i--) {
    const barHeight = Math.max(WAVE_MIN_BAR_HEIGHT, visible[i]! * height)
    ctx.beginPath()
    ctx.roundRect(x, midY - barHeight / 2, WAVE_BAR_WIDTH, barHeight, WAVE_BAR_WIDTH / 2)
    ctx.fill()
    x -= step
  }
}

/** The canvas draws each new sample of the capture it was mounted for. */
export const DrawWaveform = Mount.defineStream("DrawRecordingWaveform", {
  args: { key: Schema.String },
  messages: [Message.CompletedMountWaveform],
  execute: ({ element, key }) => domStream<typeof Message.CompletedMountWaveform.Type>((emit) => {
    const canvas = element as HTMLCanvasElement
    const stop = Recorder.watchLevels(key, (levels) => drawWaveform(canvas, levels))
    emit(Message.CompletedMountWaveform())
    return stop
  }),
})
