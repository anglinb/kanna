// src/foldkit/transcript/messages on AskUserQuestion and ExitPlanMode in
// each of their states (src/foldkit/transcript/messages/fixture.ts), against
// the React rows (gallery/messages-questions.tsx on the React side).
import { questionSections, readonlySections } from "../../../foldkit/transcript/messages/fixture"
import { messagesPage, rowSections } from "./support/messages-host"

const SECTIONS = questionSections()
const READONLY = readonlySections()

export default messagesPage((model, h) => [
  ...rowSections(model, SECTIONS, {}, h),
  ...rowSections(model, READONLY, { readonly: true }, h),
])
