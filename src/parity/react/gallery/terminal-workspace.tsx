// The chat page's terminal workspace without the chat page around it
// (gallery/terminal-workspace.ts on the Foldkit side): TerminalWorkspace as
// TerminalWorkspaceShell renders it, for one project's shells, on the demo's
// fake shell. The X on the only pane hides the panel (ChatPage's
// handleRemoveTerminal), a split's X kills its shell, Add's tooltip shows
// the split shortcut. The panel's height is fixed, as the chat page's
// panel is once laid out; the line above it says whether the panel is shown.
import { useCallback, useEffect, useState } from "react"
import { KannaSocket, type SocketStatus } from "../../../client/app/socket"
import { disposeCachedTerminal } from "../../../client/components/chat-ui/TerminalPane"
import { TerminalWorkspace } from "../../../client/components/chat-ui/TerminalWorkspace"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { getResolvedKeybindings } from "../../../client/lib/keybindings"
import { isTerminalVisible, useTerminalLayoutStore } from "../../../client/stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../../../client/stores/terminalPreferencesStore"

const PROJECT_ID = "demo-project-tidepool"

// Every gallery module is imported by the parity entry, so the socket is
// made when this page renders, not when the module loads.
function makeSocket() {
  const socket = new KannaSocket(`ws://${window.location.host}/ws`)
  socket.start()
  return socket
}

export default function TerminalWorkspaceGallery() {
  const [socket] = useState(makeSocket)
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const layout = useTerminalLayoutStore((store) => store.projects[PROJECT_ID])
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const hideTerminals = useTerminalLayoutStore((store) => store.hideTerminals)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const hasTerminals = (layout?.terminals.length ?? 0) > 0

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  // The chat page's toggle adds the first pane; here the page does.
  useEffect(() => {
    if (!hasTerminals) addTerminal(PROJECT_ID)
  }, [addTerminal, hasTerminals])

  // ChatPage's handleRemoveTerminal.
  const handleRemoveTerminal = useCallback((projectId: string, terminalId: string) => {
    const paneCount = useTerminalLayoutStore.getState().projects[projectId]?.terminals.length ?? 0
    if (paneCount <= 1) {
      hideTerminals(projectId, null)
      return
    }
    void socket.command({ type: "terminal.close", terminalId }).catch(() => {})
    removeTerminal(projectId, terminalId)
    void Promise.resolve().then(() => disposeCachedTerminal(terminalId))
  }, [hideTerminals, removeTerminal, socket])

  const shown = layout ? isTerminalVisible(layout, null) : false

  return (
    <TooltipProvider>
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <p className="px-4 py-2 text-sm">{shown ? "Panel shown" : "Panel hidden"}</p>
        <div className="h-[420px] min-h-0 overflow-hidden relative border-t border-border" data-terminal-visual="true">
          {layout && hasTerminals && connectionStatus === "connected" ? (
            <TerminalWorkspace
              projectId={PROJECT_ID}
              layout={layout}
              onAddTerminal={addTerminal}
              socket={socket}
              connectionStatus={connectionStatus}
              scrollback={scrollback}
              minColumnWidth={minColumnWidth}
              splitTerminalShortcut={getResolvedKeybindings(null).bindings.addSplitTerminal}
              lastPaneClose="hide"
              focusRequestVersion={0}
              onRemoveTerminal={handleRemoveTerminal}
              onTerminalLayout={setTerminalSizes}
            />
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  )
}
