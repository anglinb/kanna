// src/foldkit/transcript/messages on messages that name other chats, with a
// sidebar that knows some of them and no way to open one
// (src/foldkit/transcript/messages/fixture.ts), against the React rows
// (gallery/messages-references.tsx on the React side).
import { flattenSidebarThreads } from "../../../client/lib/thread-sections"
import { REFERENCES_PARENTS, REFERENCES_PROJECT_ID, REFERENCES_SIDEBAR, referencesSections } from "../../../foldkit/transcript/messages/fixture"
import { item, messagesPage, rowSections } from "./support/messages-host"

const SECTIONS = referencesSections()
const THREADS = new Map(flattenSidebarThreads(REFERENCES_SIDEBAR).map((thread) => [thread.chatId, thread]))

const references = {
  sidebarThread: (chatId: string | null | undefined) => (chatId ? THREADS.get(chatId) ?? null : null),
  sidebarReady: true,
  currentProjectId: REFERENCES_PROJECT_ID,
}

export default messagesPage((model, h) => [
  h.section([h.AriaLabel("Parent links"), h.Class("mb-6")], REFERENCES_PARENTS.map((parentChatId) =>
    // As ChatTranscriptViewport's list header.
    h.keyed("div")(parentChatId, [h.Class("mx-auto flex w-full max-w-[816px] justify-start px-2 pb-3 pt-1")], [
      item(model, `parent-${parentChatId}`, { ...references, item: { kind: "parent-chat-link", parentChatId } }, h),
    ]))),
  ...rowSections(model, SECTIONS, {}, h, references),
])
