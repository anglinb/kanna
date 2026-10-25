// src/foldkit/transcript/messages on the prompt, answer, session and turn
// rows of src/foldkit/transcript/messages/fixture.ts, against the React rows
// (gallery/messages-text.tsx on the React side).
import { queuedMessages, textSections, USAGE_LIMIT_RESUME } from "../../../foldkit/transcript/messages/fixture"
import { item, messagesPage, RESUME_KEY, rowSections } from "./support/messages-host"

const SECTIONS = textSections(window.location.origin)
const QUEUED = queuedMessages(window.location.origin)

export default messagesPage((model, h) => [
  ...rowSections(model, SECTIONS, {}, h),
  h.section([h.AriaLabel("Footer"), h.Class("mb-6")], [
    // As ChatTranscriptViewport's list footer.
    h.div([h.Class("mx-auto w-full max-w-[816px] px-2")], [
      item(model, "processing", { item: { kind: "processing" } }, h),
      item(model, "processing-connecting", { item: { kind: "processing", status: "connecting" } }, h),
      item(model, "processing-failed", { item: { kind: "processing", status: "failed" } }, h),
      item(model, "processing-waiting", { item: { kind: "processing", status: "waiting_on_subagent", waitingOn: { chats: 2, agents: 1 } } }, h),
      item(model, RESUME_KEY, { item: { kind: "usage-limit", resume: USAGE_LIMIT_RESUME, key: RESUME_KEY }, now: Date.now() }, h),
      ...QUEUED.map((message) => item(model, `queued-${message.id}`, { item: { kind: "queued", message } }, h)),
      item(model, "draining", { item: { kind: "draining" } }, h),
    ]),
  ]),
])
