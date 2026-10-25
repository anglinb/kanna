// Display tools: attachments in their shapes, and charts, through
// KannaTranscriptRow, on src/foldkit/transcript/messages/fixture.ts.
// Matched by gallery/messages-display.ts on the Foldkit side.
import { displaySections } from "../../../foldkit/transcript/messages/fixture"
import { GalleryShell, RowSections, useGalleryStatus } from "./support/messages-host"

const SECTIONS = displaySections(window.location.origin)

export default function MessagesDisplayGallery() {
  const { status, setStatus, onAnswer, onPlan } = useGalleryStatus()
  return (
    <GalleryShell status={status}>
      <RowSections sections={SECTIONS} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
    </GalleryShell>
  )
}
