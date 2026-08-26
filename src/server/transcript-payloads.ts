import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs"
import type { TranscriptEntry } from "../shared/types"
import { INLINE_TOOL_KINDS, UNBOUNDED_TOOL_INPUT_FIELDS, trimToolCallEntry } from "./events"

/**
 * Tool payloads live in a sidecar, not in the transcript.
 *
 * `transcripts/<chat>.jsonl` holds what a transcript render needs: every
 * entry, with tool calls and results cut down to their headers. The bodies
 * (a file written, an edit's old and new text, a command's output) go to
 * `transcripts/<chat>.payloads.jsonl`, one line per entry id, and come back
 * only when a row is opened.
 *
 * This is what makes a cold open scale with the number of entries instead
 * of their bytes. The 2,300-entry chat that motivated it parsed 41 MB to
 * paint 1.5 MB of headers; now it parses the 1.5 MB. The sidecar is never
 * parsed whole except by the full-fidelity readers (export, handoff, fork).
 *
 * Reads are by byte offset. The index (id to offset and length) is built
 * once per chat by scanning the sidecar for newlines, without parsing, and
 * then kept current as lines are appended.
 */

/** A header's dropped fields, keyed by entry id. */
export interface TranscriptPayload {
  _id: string
  /** Tool call: the unbounded input fields and the raw input, if any. */
  tool?: { rawInput?: unknown; input?: Record<string, unknown> }
  /** Tool result: the body. */
  content?: unknown
}

export interface SplitTranscriptEntry {
  header: TranscriptEntry
  payload: TranscriptPayload | null
}

/**
 * Cut an entry into the header the transcript keeps and the payload the
 * sidecar keeps. Entries with nothing to move come back as the same object
 * with a null payload.
 *
 * `isInlineResult` says whether a result belongs to a tool that renders
 * inline (`INLINE_TOOL_KINDS`); those keep their content in the header
 * because there is no row to open.
 */
export function splitTranscriptEntry(entry: TranscriptEntry, isInlineResult: (toolId: string) => boolean): SplitTranscriptEntry {
  if (entry.kind === "tool_call") {
    if (INLINE_TOOL_KINDS.has(entry.tool.toolKind)) return { header: entry, payload: null }
    const header = trimToolCallEntry(entry)
    if (header === entry) return { header: entry, payload: null }
    const input: Record<string, unknown> = {}
    for (const field of UNBOUNDED_TOOL_INPUT_FIELDS[entry.tool.toolKind] ?? []) {
      const value = (entry.tool.input as Record<string, unknown>)[field]
      if (value !== undefined) input[field] = value
    }
    const payload: TranscriptPayload = { _id: entry._id, tool: {} }
    if (entry.tool.rawInput !== undefined) payload.tool!.rawInput = entry.tool.rawInput
    if (Object.keys(input).length > 0) payload.tool!.input = input
    return { header, payload }
  }

  if (entry.kind === "tool_result") {
    if (entry.trimmed || entry.content === undefined || isInlineResult(entry.toolId)) {
      return { header: entry, payload: null }
    }
    const { content, ...rest } = entry
    return {
      header: { ...rest, trimmed: true } as TranscriptEntry,
      payload: { _id: entry._id, content },
    }
  }

  return { header: entry, payload: null }
}

/** The whole entry again: header plus what the sidecar held for it. */
export function mergeTranscriptPayload(header: TranscriptEntry, payload: TranscriptPayload | undefined): TranscriptEntry {
  if (!payload) return header
  const { trimmed, ...rest } = header as TranscriptEntry & { trimmed?: true }
  if (rest.kind === "tool_call" && payload.tool) {
    return {
      ...rest,
      tool: {
        ...rest.tool,
        ...(payload.tool.rawInput !== undefined ? { rawInput: payload.tool.rawInput } : {}),
        input: { ...(rest.tool.input as Record<string, unknown>), ...(payload.tool.input ?? {}) },
      },
    } as TranscriptEntry
  }
  if (rest.kind === "tool_result" && "content" in payload) {
    return { ...rest, content: payload.content } as TranscriptEntry
  }
  return header
}

interface PayloadSpan {
  offset: number
  length: number
}

const ID_PREFIX = '{"_id":"'

/**
 * Where each payload line sits in the sidecar. Lines are written with `_id`
 * first, so the id is read straight off the line's prefix and nothing is
 * parsed. A repeated id (a rewrite that died before its rename) resolves
 * to the last line, which is the newest.
 */
export class TranscriptPayloadIndex {
  private readonly spans = new Map<string, PayloadSpan>()
  /** Bytes of the sidecar covered by the index; the next append starts here. */
  private scannedBytes = 0

  constructor(private readonly sidecarPath: string) {
    if (existsSync(sidecarPath)) this.scan(readFileSync(sidecarPath))
  }

  /** Account for a line this process just appended, without touching disk. */
  noteAppended(payloadId: string, lineBytes: number) {
    this.spans.set(payloadId, { offset: this.scannedBytes, length: lineBytes })
    this.scannedBytes += lineBytes
  }

  has(payloadId: string) {
    return this.spans.has(payloadId)
  }

  /** One positional read; null when the id is not in the sidecar. */
  read(payloadId: string): TranscriptPayload | null {
    const span = this.spans.get(payloadId)
    if (!span) return null
    const fd = openSync(this.sidecarPath, "r")
    try {
      const buffer = Buffer.alloc(span.length)
      readSync(fd, buffer, 0, span.length, span.offset)
      return JSON.parse(buffer.toString("utf8")) as TranscriptPayload
    } catch {
      // A truncated or garbled line loses one payload, not the transcript.
      return null
    } finally {
      closeSync(fd)
    }
  }

  private scan(bytes: Buffer) {
    let start = 0
    while (start < bytes.length) {
      let end = bytes.indexOf(0x0a, start)
      if (end === -1) end = bytes.length
      const length = end - start
      const id = readIdPrefix(bytes, start, end)
      if (id !== null) this.spans.set(id, { offset: start, length })
      start = end + 1
    }
    this.scannedBytes = bytes.length
  }
}

function readIdPrefix(bytes: Buffer, start: number, end: number): string | null {
  const head = bytes.toString("utf8", start, Math.min(end, start + 256))
  if (!head.startsWith(ID_PREFIX)) return null
  const close = head.indexOf('"', ID_PREFIX.length)
  if (close === -1) return null
  const raw = head.slice(ID_PREFIX.length, close)
  // Ids are UUIDs and tool ids; neither needs JSON unescaping. Anything
  // with a backslash is not one of ours.
  return raw.includes("\\") ? null : raw
}

/** Serialize a payload with `_id` first, which the index scan depends on. */
export function serializeTranscriptPayload(payload: TranscriptPayload) {
  const { _id, ...rest } = payload
  return `${JSON.stringify({ _id, ...rest })}\n`
}

/** Every payload in a sidecar, for the full-fidelity readers. */
export function readAllTranscriptPayloads(sidecarPath: string): Map<string, TranscriptPayload> {
  const payloads = new Map<string, TranscriptPayload>()
  if (!existsSync(sidecarPath)) return payloads
  for (const line of readFileSync(sidecarPath, "utf8").split("\n")) {
    if (!line) continue
    try {
      const payload = JSON.parse(line) as TranscriptPayload
      payloads.set(payload._id, payload)
    } catch {
      // Skip a garbled line rather than fail the whole read.
    }
  }
  return payloads
}
