// The transcript's prompt, answer, session and turn rows, through the real
// React components (KannaTranscriptRow and the footer's rows), on the
// fixtures in src/foldkit/transcript/messages/fixture.ts. Matched by
// gallery/messages-text.ts on the Foldkit side.
import { DrainingIndicator } from "../../../client/components/messages/DrainingIndicator"
import { ProcessingMessage } from "../../../client/components/messages/ProcessingMessage"
import { QueuedUserMessage } from "../../../client/components/messages/QueuedUserMessage"
import { UsageLimitResumeRow } from "../../../client/components/messages/UsageLimitResumeRow"
import { TranscriptRenderOptionsProvider } from "../../../client/components/messages/render-context"
import { EXPORT_OPTIONS, exportSections, queuedMessages, textSections, USAGE_LIMIT_RESUME } from "../../../foldkit/transcript/messages/fixture"
import { describeQueued, describeResume, STOPPED } from "../../../foldkit/transcript/messages/fixture-status"
import { GalleryShell, RowSections, useGalleryStatus } from "./support/messages-host"

const SECTIONS = textSections(window.location.origin)
const EXPORT = exportSections(window.location.origin)
const QUEUED = queuedMessages(window.location.origin)

export default function MessagesTextGallery() {
  const { status, setStatus, onAnswer, onPlan } = useGalleryStatus()
  return (
    <GalleryShell status={status}>
      <RowSections sections={SECTIONS} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
      <TranscriptRenderOptionsProvider value={EXPORT_OPTIONS}>
        <RowSections sections={EXPORT} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
      </TranscriptRenderOptionsProvider>
      <section aria-label="Footer" className="mb-6">
        {/* As ChatTranscriptViewport's list footer. */}
        <div className="mx-auto w-full max-w-[816px] px-2">
          <ProcessingMessage />
          <ProcessingMessage status="connecting" />
          <ProcessingMessage status="failed" />
          <ProcessingMessage status="waiting_on_subagent" waitingOn={{ chats: 2, agents: 1 }} />
          <UsageLimitResumeRow resume={USAGE_LIMIT_RESUME} onAction={(action) => setStatus(describeResume(action))} />
          {QUEUED.map((message) => (
            <QueuedUserMessage
              key={message.id}
              message={message}
              onRemove={() => setStatus(describeQueued(message.id, "remove"))}
              onSendNow={() => setStatus(describeQueued(message.id, "send-now"))}
            />
          ))}
          <DrainingIndicator onStop={() => setStatus(STOPPED)} />
        </div>
      </section>
    </GalleryShell>
  )
}
