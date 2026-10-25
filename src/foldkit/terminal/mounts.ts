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
        emit(Message.MeasuredWorkspace({ width }))
      }
      const observer = new ResizeObserver(updateWidth)
      observer.observe(element)
      updateWidth()

      const inputs = watchMountInputs<WorkspaceInputs>(element, (next, previous) => {
        const addedTerminalId = next.terminalIds.find((id) => !previous.terminalIds.includes(id))
        if (!addedTerminalId || previous.terminalIds.length === 0) return
        // The pane's own element: the panel's inner div holds it.
        const pane = document.getElementById(addedTerminalId)?.firstElementChild?.firstElementChild
        pane?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
      })

      return () => {
        inputs.stop()
        observer.disconnect()
      }
    }),
})
