import { describe, expect, test } from "bun:test"
import { processTranscriptMessages } from "../../client/lib/parseTranscript"
import type { TranscriptEntry } from "../../shared/types"
import { buildResolvedTranscriptRows, resolvedRows } from "./resolve"

// KannaTranscript's row resolver, as ported: which messages draw a row,
// which fold into a tool group, and the flags a row is drawn with.

let clock = 0
function entries(drafts: ReadonlyArray<Record<string, unknown>>): TranscriptEntry[] {
  return drafts.map((draft) => ({ ...draft, createdAt: (clock += 1000) }) as unknown as TranscriptEntry)
}

const read = (id: string, toolId: string) => ({ _id: id, kind: "tool_call", tool: { kind: "tool", toolKind: "read_file", toolName: "Read", toolId, input: { filePath: `/p/${id}.ts` } } })
const done = (id: string, toolId: string) => ({ _id: id, kind: "tool_result", toolId, content: "ok" })

const CHAT = entries([
  { _id: "init-1", kind: "system_init", provider: "claude", model: "opus", tools: [], agents: [], slashCommands: [], mcpServers: [] },
  { _id: "p1", kind: "user_prompt", content: "Fix it" },
  { _id: "t1", kind: "assistant_text", text: "Reading." },
  read("r1", "tr1"), done("r1-r", "tr1"),
  read("r2", "tr2"), done("r2-r", "tr2"),
  { _id: "res-1", kind: "result", subtype: "success", isError: false, durationMs: 1000, result: "" },
  { _id: "init-2", kind: "system_init", provider: "claude", model: "opus", tools: [], agents: [], slashCommands: [], mcpServers: [] },
  { _id: "p2", kind: "user_prompt", content: "Again" },
  { _id: "res-2", kind: "result", subtype: "success", isError: false, durationMs: 5, result: "" },
])

describe("transcript rows", () => {
  const messages = processTranscriptMessages(CHAT)
  const rows = buildResolvedTranscriptRows(messages, { isLoading: false, localPath: "/p", latestToolIds: {} })

  test("a run of tool calls folds into one group keyed on its first call", () => {
    const group = rows.find((row) => row.kind === "tool-group")
    expect(group?.id).toBe("r1")
    expect(group?.kind === "tool-group" ? group.messages.map((message) => message.id) : []).toEqual(["r1", "r2"])
  })

  test("only the first session init draws, a repeat of the same model does not", () => {
    expect(rows.filter((row) => row.kind === "single" && row.message.kind === "system_init").map((row) => row.id)).toEqual(["init-1"])
  })

  test("a turn that showed nothing hides its result; a result names the prompt that follows", () => {
    const ids = rows.map((row) => row.id)
    expect(ids).toEqual(["init-1", "p1", "t1", "r1", "res-1", "p2"])
    const result = rows.find((row) => row.id === "res-1")
    expect(result?.kind === "single" ? result.nextPromptTimestamp : null).toBe(new Date(10_000 + clockBase()).toISOString())
  })

  test("a call still running is loading only while the chat is", () => {
    const running = processTranscriptMessages(entries([{ _id: "p9", kind: "user_prompt", content: "Go" }, read("r9", "tr9")]))
    const idle = buildResolvedTranscriptRows(running, { isLoading: false, latestToolIds: {} })
    const busy = buildResolvedTranscriptRows(running, { isLoading: true, latestToolIds: {} })
    expect(idle.find((row) => row.id === "r9")?.isLoading).toBe(false)
    expect(busy.find((row) => row.id === "r9")?.isLoading).toBe(true)
  })

  test("the rows are built once per input", () => {
    const options = { isLoading: false, localPath: "/p", latestToolIds: {} }
    expect(resolvedRows(messages, options)).toBe(resolvedRows(messages, { ...options, latestToolIds: {} }))
    expect(resolvedRows(messages, options)).not.toBe(resolvedRows(messages, { ...options, isLoading: true }))
  })
})

/** CHAT's entries start after whatever the clock read before it was built. */
function clockBase() {
  return CHAT[0]!.createdAt - 1000
}
