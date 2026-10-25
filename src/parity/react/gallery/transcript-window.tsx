// The transcript viewport over a window of a longer chat (the fixture in
// src/foldkit/transcript/fixture.ts): Load More, the older slice landing in
// front of the rows on screen, and the minimap's turns before the window.
// The real ChatTranscriptViewport, with the loads a chat page would make
// answered here after 50ms. Matched by gallery/transcript-window.ts.
import { useCallback, useMemo, useRef, useState } from "react"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "../../../client/app/ChatPage/ChatTranscriptViewport"
import { getLatestToolIds } from "../../../client/app/derived"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { processTranscriptMessages } from "../../../client/lib/parseTranscript"
import { olderStart, WINDOW_CHAT_ID, windowFixture } from "../../../foldkit/transcript/fixture"

const FIXTURE = windowFixture()
/** How long a load takes to land, as a socket round trip would. */
const LOAD_MS = 50

export default function TranscriptWindowGallery() {
  const [start, setStart] = useState(FIXTURE.initialStart)
  const [loading, setLoading] = useState(false)
  const [isAtEnd, setIsAtEnd] = useState(true)
  const listRef = useRef<TranscriptScrollHandle | null>(null)
  const messages = useMemo(() => processTranscriptMessages(FIXTURE.entries.slice(start)), [start])
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])
  const noop = useCallback(() => undefined, [])
  const noopPromise = useCallback(() => Promise.resolve(), [])
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd()
  }, [])
  const onLoadOlderMessages = useCallback(async (options?: { untilMessageId?: string; all?: boolean }) => {
    setLoading(true)
    await new Promise((resolve) => setTimeout(resolve, LOAD_MS))
    setStart((current) => olderStart(FIXTURE, current, options?.untilMessageId))
    setLoading(false)
  }, [])

  return (
    <TooltipProvider>
      <div className="relative h-full bg-background">
        <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
          <ChatTranscriptViewport
            activeChatId={WINDOW_CHAT_ID}
            listRef={listRef}
            messages={messages}
            queuedMessages={[]}
            transcriptPaddingBottom={120}
            localPath="/Users/demo/code/tidepool"
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
            hasOlderMessages={start > 0}
            transcriptOutline={FIXTURE.outline}
            onLoadOlderMessages={onLoadOlderMessages}
            isLoadingOlderMessages={loading}
          />
        </div>
      </div>
    </TooltipProvider>
  )
}
