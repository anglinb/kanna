// The status line of the message-row galleries: what the last press asked
// the host for, in words, so a scenario sees a press land the same way in
// both apps. Shared by src/parity/{react,foldkit}/gallery/support/messages-host.
import type { AskUserQuestionAnswerMap } from "../../../shared/types"
import { describeLocalLink } from "../../markdown/fixture"

export const NO_ACTION = "Nothing asked for yet"

export function describeAnswers(toolUseId: string, answers: AskUserQuestionAnswerMap) {
  return `Answered ${toolUseId}: ${JSON.stringify(answers)}`
}

export function describePlan(toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) {
  return `Plan ${toolUseId}: ${confirmed ? "approved" : "adjusted"}${clearContext ? ", clear context" : ""}${message !== undefined ? `, "${message}"` : ""}`
}

export function describeLocalLinkOpen(target: { path: string; line?: number; column?: number; trigger?: string }) {
  return describeLocalLink(target)
}

export function describeQueued(messageId: string, action: "remove" | "send-now") {
  return `Queued ${messageId}: ${action}`
}

export function describeResume(action: "cancel" | "now") {
  return `Resume: ${action}`
}

export const STOPPED = "Stop pressed"
