import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TranscriptEntry } from "../shared/types"
import {
  mergeTranscriptPayload,
  readAllTranscriptPayloads,
  serializeTranscriptPayload,
  splitTranscriptEntry,
  TranscriptPayloadIndex,
} from "./transcript-payloads"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-transcript-payloads-"))
  dirs.push(dir)
  return dir
}

function toolCall(toolKind: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): TranscriptEntry {
  return {
    _id: `call-${toolKind}`,
    createdAt: 1,
    kind: "tool_call",
    tool: { kind: "tool", toolKind, toolName: toolKind, toolId: `tid-${toolKind}`, input, ...extra },
  } as unknown as TranscriptEntry
}

function toolResult(toolKind: string, content: unknown, extra: Record<string, unknown> = {}): TranscriptEntry {
  return { _id: `result-${toolKind}`, createdAt: 2, kind: "tool_result", toolId: `tid-${toolKind}`, content, ...extra } as unknown as TranscriptEntry
}

const notInline = () => false

describe("splitTranscriptEntry / mergeTranscriptPayload", () => {
  test("round-trips a write call and a result through header and payload", () => {
    const call = toolCall("write_file", { filePath: "a.ts", content: "x".repeat(1000) }, { rawInput: { file_path: "a.ts" } })
    const split = splitTranscriptEntry(call, notInline)
    expect((split.header as { tool: { input: unknown; rawInput?: unknown } }).tool.input).toEqual({ filePath: "a.ts" })
    expect((split.header as { tool: { rawInput?: unknown } }).tool.rawInput).toBeUndefined()
    expect(split.header.trimmed).toBe(true)
    expect(split.payload).toEqual({ _id: "call-write_file", tool: { rawInput: { file_path: "a.ts" }, input: { content: "x".repeat(1000) } } })
    expect(mergeTranscriptPayload(split.header, split.payload!)).toEqual(call)

    const result = toolResult("write_file", "written", { isError: false })
    const resultSplit = splitTranscriptEntry(result, notInline)
    expect(resultSplit.header).toEqual({ _id: "result-write_file", createdAt: 2, kind: "tool_result", toolId: "tid-write_file", isError: false, trimmed: true } as unknown as TranscriptEntry)
    expect(resultSplit.payload).toEqual({ _id: "result-write_file", content: "written" })
    expect(mergeTranscriptPayload(resultSplit.header, resultSplit.payload!)).toEqual(result)
  })

  test("leaves header-sized calls, inline kinds and already-trimmed headers alone", () => {
    const bash = toolCall("bash", { command: "ls" })
    expect(splitTranscriptEntry(bash, notInline)).toEqual({ header: bash, payload: null })

    const todo = toolCall("todo_write", { todos: [{ content: "x".repeat(5000) }] })
    expect(splitTranscriptEntry(todo, notInline).payload).toBeNull()
    const inlineResult = toolResult("todo_write", { ok: true })
    expect(splitTranscriptEntry(inlineResult, (toolId) => toolId === "tid-todo_write").payload).toBeNull()

    const trimmed = { ...toolResult("bash", undefined), trimmed: true } as unknown as TranscriptEntry
    expect(splitTranscriptEntry(trimmed, notInline).header).toBe(trimmed)

    const text = { _id: "a", createdAt: 1, kind: "assistant_text", text: "hi" } as unknown as TranscriptEntry
    expect(splitTranscriptEntry(text, notInline).header).toBe(text)
    expect(mergeTranscriptPayload(text, undefined)).toBe(text)
  })
})

describe("TranscriptPayloadIndex", () => {
  test("finds lines by offset, takes the last duplicate, and follows appends", async () => {
    const dir = await makeDir()
    const sidecar = join(dir, "c.payloads.jsonl")
    await writeFile(sidecar, [
      serializeTranscriptPayload({ _id: "r1", content: "first" }),
      "garbage line\n",
      serializeTranscriptPayload({ _id: "r2", content: "héllo wörld" }),
      serializeTranscriptPayload({ _id: "r1", content: "rewritten" }),
    ].join(""))

    const index = new TranscriptPayloadIndex(sidecar)
    expect(index.read("r1")).toEqual({ _id: "r1", content: "rewritten" })
    expect(index.read("r2")).toEqual({ _id: "r2", content: "héllo wörld" })
    expect(index.read("nope")).toBeNull()

    const line = serializeTranscriptPayload({ _id: "r3", tool: { input: { content: "body" } } })
    await appendFile(sidecar, line)
    index.noteAppended("r3", Buffer.byteLength(line, "utf8"))
    expect(index.read("r3")).toEqual({ _id: "r3", tool: { input: { content: "body" } } })
    // Still correct after the append shifted nothing before it.
    expect(index.read("r2")).toEqual({ _id: "r2", content: "héllo wörld" })

    expect([...readAllTranscriptPayloads(sidecar).keys()]).toEqual(["r1", "r2", "r3"])
    expect(readAllTranscriptPayloads(sidecar).get("r1")).toEqual({ _id: "r1", content: "rewritten" })
  })

  test("a missing sidecar is an empty index", () => {
    const index = new TranscriptPayloadIndex("/nonexistent/c.payloads.jsonl")
    expect(index.has("x")).toBe(false)
    expect(index.read("x")).toBeNull()
  })
})
