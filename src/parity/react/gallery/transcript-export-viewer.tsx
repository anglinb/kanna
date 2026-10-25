// The standalone export viewer (src/export-viewer/main.tsx) once its
// transcript has loaded, on the fixture in
// src/foldkit/transcript/export/fixture.ts. main.tsx renders itself into
// #root on import, so its ready state is restated here around the real
// ChatTranscriptViewport, ViewerLayer and render options. The theme stays
// the gallery's (?theme=), not the export's. Matched by
// gallery/transcript-export-viewer.ts on the Foldkit side.
import { useCallback, useMemo, useRef, useState } from "react"
import { ChevronRight, Flower } from "lucide-react"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "../../../client/app/ChatPage/ChatTranscriptViewport"
import { getLatestToolIds } from "../../../client/app/derived"
import { TranscriptRenderOptionsProvider } from "../../../client/components/messages/render-context"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { ViewerLayer } from "../../../client/components/viewer/ViewerLayer"
import { processTranscriptMessages } from "../../../client/lib/parseTranscript"
import { exportFixtureBundle } from "../../../foldkit/transcript/export/fixture"
import { APP_NAME } from "../../../shared/branding"

// ?bundle=chart: the last turn shows a chart, for the viewer over the page.
const BUNDLE = exportFixtureBundle({ chart: new URLSearchParams(location.search).get("bundle") === "chart" })

export default function TranscriptExportViewerGallery() {
  const [isAtEnd, setIsAtEnd] = useState(true)
  const listRef = useRef<TranscriptScrollHandle | null>(null)
  const bundle = BUNDLE
  const messages = useMemo(() => processTranscriptMessages(bundle.messages), [bundle])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const noop = useCallback(() => undefined, [])
  const noopPromise = useCallback(() => Promise.resolve(), [])
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd()
  }, [])
  const handleOpenMarketingSite = useCallback(() => {
    window.open("https://kanna.sh", "_blank", "noopener,noreferrer")
  }, [])

  return (
    <TranscriptRenderOptionsProvider
      value={{
        readonly: true,
        localLinkMode: "text",
        sourceOrigin: bundle.sourceOrigin ?? null,
        attachmentMode: bundle.attachmentMode,
      }}
    >
      <TooltipProvider>
      <div className="relative h-full bg-background">
        <ViewerLayer className="fixed" />
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <header className="flex-shrink-0 border-b border-border px-4">
            <div className="mx-auto flex h-16 w-full items-center gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <a
                  className="flex flex-shrink-0 items-center gap-2"
                  href="https://kanna.sh"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Flower className="h-5 w-5 sm:h-6 sm:w-6 text-logo" />
                  <span className="font-logo text-base uppercase sm:text-lg text-slate-600 dark:text-slate-100">
                    {APP_NAME}
                  </span>
                </a>
                <span className="hidden text-sm text-muted-foreground sm:inline">/</span>
                <span className="truncate text-sm text-muted-foreground">{bundle.title}</span>
              </div>
              <div className="flex-1 md:hidden" />
            </div>
          </header>

          <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
          <ChatTranscriptViewport
            activeChatId={bundle.chatId}
            listRef={listRef}
            messages={messages}
            queuedMessages={[]}
            transcriptPaddingBottom={120}
            localPath={bundle.localPath}
            latestToolIds={latestToolIds}
            isProcessing={false}
            runtimeStatus={null}
            isDraining={false}
            commandError={null}
            onStopDraining={noop}
            onSteerQueuedMessage={noopPromise}
            onRemoveQueuedMessage={noopPromise}
            onOpenLocalLink={noopPromise}
            onAskUserQuestionSubmit={noopPromise}
            onExitPlanModeConfirm={noopPromise}
            showScrollButton={!isAtEnd && messages.length > 0}
            onIsAtEndChange={setIsAtEnd}
            scrollToBottom={scrollToBottom}
            typedEmptyStateText=""
            isEmptyStateTypingComplete
            isPageFileDragActive={false}
            showEmptyState={false}
            headerOffsetPx={20}
          />

            <div className="absolute bottom-4 left-1/2 z-20 w-full -translate-x-1/2 md:w-auto">
              <div className="mx-2 flex items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur-lg md:mx-0">
                <Flower className="h-6 w-6 flex-shrink-0 text-logo" />
                <p className="flex-1 text-sm text-foreground sm:text-base">
                  Kanna is a delightful open-source harness UI
                </p>
                <a
                  className="ml-4 flex flex-shrink-0 flex-row items-center gap-1 rounded-lg bg-logo px-3 py-1.5 pr-2 text-sm font-bold text-white transition-colors hover:bg-logo/90"
                  href="https://kanna.sh"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.preventDefault()
                    handleOpenMarketingSite()
                  }}
                >
                  <span>Try It</span>
                  <ChevronRight className="h-4 w-4 translate-y-[0.5px]" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
      </TooltipProvider>
    </TranscriptRenderOptionsProvider>
  )
}
