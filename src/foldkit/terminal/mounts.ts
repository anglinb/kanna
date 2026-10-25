import { Schema } from "effect"
import { Mount } from "foldkit"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import { watchMountInputs } from "./mountInputs"
import { TerminalPaneController, type PaneInputs } from "./pane"

// The workspace's imperative parts, each a Mount on the element React held a
// ref to: the pane's xterm (TerminalPane's effects, in pane.ts), and the
// workspace's scroller (its width observer and the scroll to a new split).

/**
 * TerminalPane: an xterm on the `.kanna-terminal` element, its server
 * session and its output. The pane's props reach the controller through
 * `mountInputs` (see mountInputs.ts), so a changed prop re-runs the effects
 * that depended on it without remounting the pane, as in React.
 */
type PaneMessage =
  | ReturnType<typeof Message.NeededSocket>
  | ReturnType<typeof Message.ChangedPanePath>
  | ReturnType<typeof Message.ChangedPaneError>
  | ReturnType<typeof Message.SentPaneCommand>
  | ReturnType<typeof Message.SentInitialCommand>

export const TerminalPane = Mount.defineStream("TerminalPane", {
  args: { terminalId: Schema.String },
  messages: [Message.NeededSocket, Message.ChangedPanePath, Message.ChangedPaneError, Message.SentPaneCommand, Message.SentInitialCommand],
  execute: ({ element, terminalId }) =>
    domStream<PaneMessage>((emit) => {
      // Every mount asks, so a socket the app replaced since is replaced here too.
      emit(Message.NeededSocket())
      const controller = new TerminalPaneController(element as HTMLElement, terminalId, {
        pathChanged: (path) => emit(Message.ChangedPanePath({ terminalId, path })),
        errorChanged: (error) => emit(Message.ChangedPaneError({ terminalId, error })),
        commandSent: () => emit(Message.SentPaneCommand({ terminalId })),
        initialCommandSent: () => emit(Message.SentInitialCommand({ terminalId })),
      })
      const inputs = watchMountInputs<PaneInputs>(element, (next) => controller.apply(next))
      controller.apply(inputs.current())
      return () => {
        inputs.stop()
        controller.dispose()
      }
    }),
})

/** What the workspace Mount watches: the panes in order. */
export interface WorkspaceInputs {
  terminalIds: string[]
  /** The panes' minimum width (getMinimumTerminalWidth), before the scroller clamps it. */
  minTerminalWidth: number
}

/** TerminalWorkspace's inner width for a scroller `width` wide: past the panes' minimums, it scrolls. */
export function workspaceInnerWidth(width: number, paneCount: number, minTerminalWidth: number) {
  const effectiveMinTerminalWidth = width > 0 ? Math.min(minTerminalWidth, width) : minTerminalWidth
  return Math.max(width, Math.max(1, paneCount) * effectiveMinTerminalWidth)
}

/**
 * TerminalWorkspace's scroller: reports its width as it changes (the panes'
 * minimum width and the inner width follow it), and scrolls a pane added
 * beside the others into view, as its layout effects did.
 */
export const TerminalWorkspaceScroller = Mount.defineStream("TerminalWorkspaceScroller", {
  messages: [Message.MeasuredWorkspace],
  execute: ({ element }) =>
    domStream<ReturnType<typeof Message.MeasuredWorkspace>>((emit) => {
      let reported: number | null = null
      const updateWidth = () => {
        const width = element.getBoundingClientRect().width
        if (width === reported) return
        reported = width
        // React measured in a layout effect and re-rendered before the
        // browser painted, so the panes never saw the unmeasured width (one
        // pane's minimum). Foldkit renders the Message's result a frame on,
        // which can be after a pane has sized its shell by it; so the inner
        // width the next render writes is written now, the same value.
        const { terminalIds, minTerminalWidth } = inputs.current()
        const inner = element.firstElementChild as HTMLElement | null
        if (inner) {
          const innerWidth = workspaceInnerWidth(width, terminalIds.length, minTerminalWidth)
          inner.style.width = innerWidth ? `${innerWidth}px` : "100%"
        }
        emit(Message.MeasuredWorkspace({ width }))
      }

      const inputs = watchMountInputs<WorkspaceInputs>(element, (next, previous) => {
        const addedTerminalId = next.terminalIds.find((id) => !previous.terminalIds.includes(id))
        if (!addedTerminalId || previous.terminalIds.length === 0) return
        // The pane's own element: the panel's inner div holds it.
        const pane = document.getElementById(addedTerminalId)?.firstElementChild?.firstElementChild
        pane?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
      })

      const observer = new ResizeObserver(updateWidth)
      observer.observe(element)
      updateWidth()

      return () => {
        inputs.stop()
        observer.disconnect()
      }
    }),
})
