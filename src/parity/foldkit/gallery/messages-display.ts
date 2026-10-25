// src/foldkit/transcript/messages on display tools: attachments and charts
// (src/foldkit/transcript/messages/fixture.ts), against the React rows
// (gallery/messages-display.tsx on the React side).
import { displaySections } from "../../../foldkit/transcript/messages/fixture"
import { messagesPage, rowSections } from "./support/messages-host"

const SECTIONS = displaySections(window.location.origin)

export default messagesPage((model, h) => rowSections(model, SECTIONS, {}, h))
