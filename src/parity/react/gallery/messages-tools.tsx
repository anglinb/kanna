// Every tool row the transcript special-cases, folded runs and an Agent,
// through KannaTranscriptRow, on src/foldkit/transcript/messages/fixture.ts.
// Matched by gallery/messages-tools.ts on the Foldkit side.
import { toolSections } from "../../../foldkit/transcript/messages/fixture"
import { GalleryShell, RowSections, useGalleryStatus } from "./support/messages-host"

const SECTIONS = toolSections()

export default function MessagesToolsGallery() {
  const { status, setStatus, onAnswer, onPlan } = useGalleryStatus()
  return (
    <GalleryShell status={status}>
      <RowSections sections={SECTIONS} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
    </GalleryShell>
  )
}
