// AskUserQuestion and ExitPlanMode in each of their states, live and in a
// read-only export, through KannaTranscriptRow, on
// src/foldkit/transcript/messages/fixture.ts. Matched by
// gallery/messages-questions.ts on the Foldkit side.
import { TranscriptRenderOptionsProvider } from "../../../client/components/messages/render-context"
import { questionSections, readonlySections } from "../../../foldkit/transcript/messages/fixture"
import { GalleryShell, RowSections, useGalleryStatus } from "./support/messages-host"

const SECTIONS = questionSections()
const READONLY = readonlySections()

export default function MessagesQuestionsGallery() {
  const { status, setStatus, onAnswer, onPlan } = useGalleryStatus()
  return (
    <GalleryShell status={status}>
      <RowSections sections={SECTIONS} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
      <TranscriptRenderOptionsProvider value={{ readonly: true }}>
        <RowSections sections={READONLY} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
      </TranscriptRenderOptionsProvider>
    </GalleryShell>
  )
}
