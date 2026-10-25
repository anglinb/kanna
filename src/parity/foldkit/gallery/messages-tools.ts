// src/foldkit/transcript/messages on every tool row the transcript
// special-cases (src/foldkit/transcript/messages/fixture.ts), against the
// React rows (gallery/messages-tools.tsx on the React side).
import { toolSections } from "../../../foldkit/transcript/messages/fixture"
import { messagesPage, rowSections } from "./support/messages-host"

const SECTIONS = toolSections()

export default messagesPage((model, h) => rowSections(model, SECTIONS, {}, h))
