import type { ResolvedChatReadAnchor } from "../../../shared/types"
import type { ResolvedTranscriptRow } from "../KannaTranscript"
import { getUserPromptSignature } from "../kannaStateHelpers"

/**
 * Pure helpers backing transcript scroll restoration. Kept out of the viewport
 * component so the tricky identity rules stay unit testable.
 */

/** Prefix optimistic prompt ids carry until the server echoes them back. */
const OPTIMISTIC_ID_PREFIX = "optimistic:"

export function isOptimisticMessageId(messageId: string) {
  return messageId.startsWith(OPTIMISTIC_ID_PREFIX)
}

/**
 * The message id a row should be remembered by. For a tool group we use its
 * first member, which is also what the row id embeds.
 */
export function getRowAnchorMessageId(row: ResolvedTranscriptRow): string | null {
  if (row.kind === "single") return row.message.id
  return row.messages[0]?.id ?? null
}

/**
 * Maps every message id to the row that renders it.
 *
 * Tool-group rows map *all* their members, not just the head: grouping shifts
 * as a run grows, so a message that headed a group when the anchor was written
 * may sit mid-group when we restore it.
 */
export function buildRowIndexByMessageId(rows: ResolvedTranscriptRow[]): Map<string, number> {
  const map = new Map<string, number>()
  rows.forEach((row, index) => {
    if (row.kind === "single") {
      map.set(row.message.id, index)
      return
    }
    for (const message of row.messages) {
      map.set(message.id, index)
    }
  })
  return map
}

/** Index of the row rendering the most recent user prompt, or null. */
export function findLatestUserPromptRowIndex(rows: ResolvedTranscriptRow[]): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row?.kind === "single" && row.message.kind === "user_prompt") {
      return index
    }
  }
  return null
}

export interface LatestUserPrompt {
  messageId: string
  /** Content signature, used to recognise an optimistic prompt across reconciliation. */
  signature: string
  rowIndex: number
}

export function getLatestUserPrompt(rows: ResolvedTranscriptRow[]): LatestUserPrompt | null {
  const rowIndex = findLatestUserPromptRowIndex(rows)
  if (rowIndex === null) return null
  const row = rows[rowIndex]
  if (row?.kind !== "single" || row.message.kind !== "user_prompt") return null
  return {
    messageId: row.message.id,
    signature: getUserPromptSignature(row.message.content, row.message.attachments ?? []),
    rowIndex,
  }
}

/**
 * Whether the latest user prompt changed in a way that means "the user just
 * sent something" and we should pin it to the top.
 *
 * Handles the four cases that matter:
 * - streaming: the latest prompt is untouched -> false, so live output is never
 *   fought,
 * - optimistic id reconciled to the server id: same content -> false, so the
 *   echo doesn't cause a second jump,
 * - the same text sent twice: the new prompt arrives optimistic while the
 *   previous is a real id -> true,
 * - older history prepended: the *latest* prompt is unchanged -> false.
 */
export function shouldPinForNewPrompt(
  previous: LatestUserPrompt | null,
  next: LatestUserPrompt | null,
): boolean {
  if (!next) return false
  // No prior observation means this is the chat-open path, which the restore
  // logic owns — don't treat it as a send.
  if (!previous) return false
  if (previous.messageId === next.messageId) return false
  if (isOptimisticMessageId(previous.messageId) && previous.signature === next.signature) return false
  return true
}

export type TranscriptScrollTarget =
  | { kind: "end" }
  | { kind: "pin"; index: number }

/**
 * Decide where a freshly opened chat should land.
 *
 * Order: an `atEnd` anchor keeps following the stream; a message anchor pins
 * exactly where the user left off; otherwise fall back to the latest user
 * prompt so you at least land on what you asked for; finally the bottom.
 */
export function resolveRestoreTarget(
  rows: ResolvedTranscriptRow[],
  anchor: ResolvedChatReadAnchor | null,
  rowIndexByMessageId: Map<string, number>,
): TranscriptScrollTarget {
  if (rows.length === 0) return { kind: "end" }
  if (anchor?.atEnd) return { kind: "end" }

  if (anchor) {
    const index = rowIndexByMessageId.get(anchor.messageId)
    if (index !== undefined) return { kind: "pin", index }
    // Anchor sits outside the loaded window, or its message is gone.
  }

  const latestPromptIndex = findLatestUserPromptRowIndex(rows)
  if (latestPromptIndex !== null) return { kind: "pin", index: latestPromptIndex }

  return { kind: "end" }
}
