import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { ATTACH_FILES_EVENT, REQUEST_ATTACH_FILES_EVENT } from "../../client/app/chatFocusPolicy"
import { createHoldToConfirm, type HoldClock } from "../../client/lib/hold-to-confirm"
import type { KannaSocketService } from "../core/socket"
import { domStream } from "../ui/overlay/stream"
import { fileInputSelector, holdArcSelector, textareaSelector } from "./commands"
import { Message } from "./message"
import { STANDALONE_QUERY, type Model } from "./model"

// What the composer hears from outside its own elements while it is up:
// the page's requests (attach files), the installed-app media query, and a
// running hold's clock and the things that end it short.

/**
 * Stopping a turn with Escape takes a hold, not a press (HoldToStop.tsx):
 * held for half a second it is meant. The fill is linear over the whole
 * hold, because it is progress and progress does not ease, and it starts
 * on the frame of the keydown.
 */
export const HOLD_TO_STOP_MS = 500

const browserClock: HoldClock = {
  now: () => performance.now(),
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
}

const domIdOf = (model: Model) => model.instance?.domId ?? "composer"
const isMain = (model: Model) => !(model.instance?.secondary ?? false)

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  /** useIsStandalone. */
  composerStandalone: Subscription.persistentEntry(
    Dom.streamFromMediaQuery({ query: STANDALONE_QUERY, mapMatches: (matches) => Message.ChangedStandalone({ matches: matches || (navigator as { standalone?: boolean }).standalone === true }) }),
  ),

  /** Files from the viewer or a drop on the page, attached as a paste is (`attachFilesToComposer`). */
  composerAttachFiles: entry({ main: Schema.Boolean }, {
    modelToDependencies: (model) => ({ main: isMain(model) }),
    dependenciesToStream: ({ main }) => main
      ? Dom.streamFromEventFilterMapPreventDefault({
        target: () => window as EventTarget,
        type: ATTACH_FILES_EVENT,
        filterMapEvent: (event) => {
          const files = (event as CustomEvent<{ files?: unknown }>).detail?.files
          if (!Array.isArray(files) || !files.every((file) => file instanceof File)) return Option.none()
          return Option.some(Message.ReceivedFiles({ files }))
        },
      })
      : Stream.empty,
  }),

  /** The command palette's "Attach Files" opens the hidden picker, in the click that asked. */
  composerRequestAttach: entry({ main: Schema.Boolean, domId: Schema.String }, {
    modelToDependencies: (model) => ({ main: isMain(model), domId: domIdOf(model) }),
    dependenciesToStream: ({ main, domId }) => main
      ? Dom.streamFromEvent({
        target: () => window as EventTarget,
        type: REQUEST_ATTACH_FILES_EVENT,
        mapEvent: () => {
          document.querySelector<HTMLInputElement>(fileInputSelector(domId, "palette"))?.click()
          return Message.CompletedSideEffect()
        },
      })
      : Stream.empty,
  }),

  /**
   * A hold while the key is down: the ring drawn each frame off one clock
   * with the moment it confirms, and everything that ends it short. `keyup`
   * is heard on the window: the key can come up after focus has gone.
   */
  composerHold: entry({ domId: Schema.String, version: Schema.Number, holding: Schema.Boolean }, {
    modelToDependencies: (model) => ({ domId: domIdOf(model), version: model.hold.version, holding: model.hold.phase === "holding" }),
    dependenciesToStream: ({ domId, version, holding }) => !holding
      ? Stream.empty
      : domStream<Message>((emit) => {
        const arc = document.querySelector<SVGCircleElement>(holdArcSelector(domId))
        const origin = document.querySelector<HTMLElement>(textareaSelector(domId))
        // A press that lands while the ring is still on its way back takes
        // it from where it is. Read before the transition is switched off,
        // which is what freezes it there.
        let from = 0
        if (arc) {
          const offset = Number.parseFloat(getComputedStyle(arc).strokeDashoffset)
          if (Number.isFinite(offset)) from = Math.min(1, Math.max(0, 1 - offset))
          arc.style.transition = "none"
        }
        let done = false
        const hold = createHoldToConfirm({
          durationMs: HOLD_TO_STOP_MS,
          clock: browserClock,
          onProgress: (progress) => {
            if (arc) arc.style.strokeDashoffset = String(1 - progress)
          },
          onConfirm: () => {
            done = true
            emit(Message.ConfirmedHold({ version }))
          },
        })
        const release = () => {
          if (done || hold.release() === null) return
          done = true
          emit(Message.ReleasedHold({ version }))
        }
        const onKeyUp = (event: KeyboardEvent) => { if (event.key === "Escape") release() }
        const onVisibility = () => { if (document.visibilityState === "hidden") release() }
        const onFocusIn = (event: FocusEvent) => { if (event.target !== origin) release() }
        window.addEventListener("keyup", onKeyUp, true)
        window.addEventListener("blur", release)
        document.addEventListener("visibilitychange", onVisibility)
        document.addEventListener("focusin", onFocusIn)
        origin?.addEventListener("blur", release)
        hold.press(from)
        return () => {
          hold.release()
          window.removeEventListener("keyup", onKeyUp, true)
          window.removeEventListener("blur", release)
          document.removeEventListener("visibilitychange", onVisibility)
          document.removeEventListener("focusin", onFocusIn)
          origin?.removeEventListener("blur", release)
        }
      }),
  }),
}))
