// The new chat page's project section (src/client/app/ChatPage/
// EmptyStateProject.tsx): the picker under the hero, and the project's chats
// below it, laid out as ChatTranscriptViewport lays them out in its empty
// state's scroller (gallery/chat-empty-state.ts on the Foldkit side).
import { useState, type CSSProperties } from "react"
import { EmptyStateProjectChats, EmptyStateProjectPicker } from "../../../client/app/ChatPage/EmptyStateProject"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { useSidebarStore } from "../../../client/stores/sidebarStore"
import { EMPTY_STATE_PROJECT_ID, EMPTY_STATE_PROJECT_PATH, EMPTY_STATE_SIDEBAR } from "./support/empty-state-sidebar"

export default function ChatEmptyStateGallery() {
  // Once, as the page opens, before the list below reads the store. Not at
  // import: every gallery module is imported by the app's entry, and the
  // app's own sidebar would start out as this one.
  useState(() => {
    useSidebarStore.setState({ data: EMPTY_STATE_SIDEBAR, ready: true })
    return null
  })
  return (
    <TooltipProvider>
      <div className="relative h-dvh bg-background text-foreground">
        <div className="pointer-events-none absolute inset-x-4" style={{ top: 0, bottom: 0 }}>
          <div
            data-empty-state-scroller
            className="pointer-events-auto mx-auto flex h-full max-w-[840px] flex-col items-center overflow-y-auto scrollbar-hide"
            style={{ "--empty-state-header-offset": "72px" } as CSSProperties}
          >
            <div aria-hidden className="w-full shrink-0" style={{ height: 72 }} />
            <div className="my-auto flex w-full flex-col items-center gap-[6vh] py-6">
              <div className="flex w-full flex-col items-center gap-4">
                <div className="flex max-w-full justify-center transition-opacity duration-300 pointer-events-auto opacity-100">
                  <EmptyStateProjectPicker localPath={EMPTY_STATE_PROJECT_PATH} />
                </div>
              </div>
              <div className="flex w-full justify-center transition-opacity duration-500 pointer-events-auto opacity-100">
                <div className="w-full space-y-3">
                  <EmptyStateProjectChats projectId={EMPTY_STATE_PROJECT_ID} activeChatId={null} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
