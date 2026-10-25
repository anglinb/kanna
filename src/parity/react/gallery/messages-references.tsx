// Messages that name other chats (quotes, report lines, an adoption, a chat
// card, the link back to a parent), drawn with a sidebar that knows some of
// them, through the real React components, on
// src/foldkit/transcript/messages/fixture.ts. No chat actions are provided,
// as outside a chat page: known chats lend their titles and captions, and
// nothing opens. Matched by gallery/messages-references.ts on the Foldkit side.
import { useState } from "react"
import { ParentChatLink } from "../../../client/components/messages/ParentChatLink"
import { ReplyQuoteProjectContext } from "../../../client/components/messages/ChatToolMessage"
import { useSidebarStore } from "../../../client/stores/sidebarStore"
import { REFERENCES_PARENTS, REFERENCES_PROJECT_ID, REFERENCES_SIDEBAR, referencesSections } from "../../../foldkit/transcript/messages/fixture"
import { GalleryShell, RowSections, useGalleryStatus } from "./support/messages-host"

const SECTIONS = referencesSections()

export default function MessagesReferencesGallery() {
  // On this page only (every gallery module is loaded on every page), and
  // before anything under it reads the sidebar.
  useState(() => useSidebarStore.getState().setSnapshot(REFERENCES_SIDEBAR))
  const { status, setStatus, onAnswer, onPlan } = useGalleryStatus()
  return (
    <GalleryShell status={status}>
      <ReplyQuoteProjectContext.Provider value={REFERENCES_PROJECT_ID}>
        <section aria-label="Parent links" className="mb-6">
          {REFERENCES_PARENTS.map((parentChatId) => (
            // As ChatTranscriptViewport's list header.
            <div key={parentChatId} className="mx-auto flex w-full max-w-[816px] justify-start px-2 pb-3 pt-1">
              <ParentChatLink parentChatId={parentChatId} />
            </div>
          ))}
        </section>
        <RowSections sections={SECTIONS} onAnswer={onAnswer} onPlan={onPlan} onStatus={setStatus} />
      </ReplyQuoteProjectContext.Provider>
    </GalleryShell>
  )
}
