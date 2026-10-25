// Transcript fixtures for the message-row galleries
// (src/parity/{react,foldkit}/gallery/messages-*), shared by both sides so
// the React rows and the Foldkit views draw the same messages. Entries go
// through `processTranscriptMessages`, as a chat's do; rows are built by
// hand, with the flags KannaTranscript's row resolver would set, so a
// difference is the row's and not the resolver's.
import { processTranscriptMessages } from "../../../client/lib/parseTranscript"
import type { ChartToolPayload } from "../../../shared/display-tools"
import type {
  ChatAttachment,
  HydratedTranscriptMessage,
  NormalizedToolCall,
  QueuedChatMessage,
  TranscriptEntry,
} from "../../../shared/types"
import type { SingleRow, ToolGroupRow, TranscriptRow } from "./rows"

/** Every entry an hour before the runner's frozen clock (2026-06-01T12:00Z), a second apart. */
const BASE_TIME = Date.UTC(2026, 5, 1, 11, 0, 0)
let clock = 0
function at() {
  clock += 1
  return BASE_TIME + clock * 1000
}

type Draft = TranscriptEntry extends infer T ? T extends TranscriptEntry ? Omit<T, "createdAt"> : never : never

function entries(drafts: ReadonlyArray<Draft>): TranscriptEntry[] {
  return drafts.map((draft) => ({ ...draft, createdAt: at() }) as TranscriptEntry)
}

/** Hydrates entries and indexes the messages by id. */
function hydrate(drafts: ReadonlyArray<Draft>): Map<string, HydratedTranscriptMessage> {
  const messages = processTranscriptMessages(entries(drafts))
  return new Map(messages.map((message) => [message.id, message]))
}

function call(id: string, tool: NormalizedToolCall, extra: Partial<Draft> = {}): Draft {
  return { _id: id, kind: "tool_call", tool, ...extra } as Draft
}

function result(id: string, toolId: string, content: unknown, extra: { isError?: boolean; structuredResult?: unknown } = {}): Draft {
  return { _id: id, kind: "tool_result", toolId, content, ...extra }
}

function prompt(id: string, content: string, extra: Partial<Extract<TranscriptEntry, { kind: "user_prompt" }>> = {}): Draft {
  return { _id: id, kind: "user_prompt", content, ...extra }
}

function said(id: string, text: string): Draft {
  return { _id: id, kind: "assistant_text", text }
}

const SINGLE_DEFAULTS = {
  isLoading: false,
  isFirstSystem: false,
  isModelChange: false,
  isFirstAccount: false,
  isLatestAskUserQuestion: false,
  isLatestExitPlanMode: false,
  isLatestTodoWrite: false,
  hideResult: false,
  isFinalStatus: false,
} as const

let rowIndex = 0
function single(message: HydratedTranscriptMessage | undefined, flags: Partial<Omit<SingleRow, "kind" | "id" | "message" | "index">> = {}): SingleRow {
  if (!message) throw new Error("fixture: no such message")
  rowIndex += 1
  return { kind: "single", id: message.id, message, index: rowIndex, localPath: LOCAL_PATH, ...SINGLE_DEFAULTS, ...flags }
}

function group(messages: ReadonlyArray<HydratedTranscriptMessage | undefined>, isLoading = false): ToolGroupRow {
  const list = messages.map((message) => {
    if (!message) throw new Error("fixture: no such message")
    return message
  })
  rowIndex += 1
  return { kind: "tool-group", id: list[0]!.id, startIndex: rowIndex, messages: list, isLoading, localPath: LOCAL_PATH }
}

export const LOCAL_PATH = "/Users/demo/code/kanna"

export interface GallerySection {
  /** The section's accessible name (an `aria-label` on its `<section>`). */
  label: string
  rows: TranscriptRow[]
}

// ── Attachments ──────────────────────────────────────────────────────────

/** Attachments with files the gallery's own server has (public/), so previews load in both apps. */
export function chatAttachments(origin: string): ChatAttachment[] {
  return [
    {
      id: "att-image",
      kind: "image",
      displayName: "screenshot-light.png",
      absolutePath: "/Users/demo/Desktop/screenshot-light.png",
      relativePath: "screenshot-light.png",
      contentUrl: `${origin}/screenshot-light.png`,
      mimeType: "image/png",
      size: 482_133,
    },
    {
      id: "att-text",
      kind: "file",
      displayName: "notes.md",
      absolutePath: "/Users/demo/code/kanna/notes.md",
      relativePath: "notes.md",
      contentUrl: `${origin}/notes.md`,
      mimeType: "text/markdown",
      size: 2_048,
    },
    {
      id: "att-pdf",
      kind: "file",
      displayName: "Quarterly report with a long name that truncates.pdf",
      absolutePath: "/Users/demo/Documents/report.pdf",
      relativePath: "report.pdf",
      contentUrl: `${origin}/report.pdf`,
      mimeType: "application/pdf",
      size: 1_572_864,
    },
  ]
}

const LONG_PROMPT = Array.from({ length: 34 }, (_, index) => `Line ${index + 1} of a long prompt pasted from a log, kept as it was typed.`).join("\n")

const MARKDOWN_ANSWER = [
  "Found it. The flicker comes from **two** renders racing on mount:",
  "",
  "1. `useLayoutEffect` sets the width",
  "2. the observer fires again with the same value",
  "",
  "```ts",
  "const width = element.clientWidth",
  "setWidth(width)",
  "```",
  "",
  "See [src/app.ts](src/app.ts) for the fix, and the table below:",
  "",
  "| Case | Before | After |",
  "| --- | --- | --- |",
  "| Mount | 2 | 1 |",
  "| Resize | 3 | 1 |",
].join("\n")

// ── Page: messages-text ──────────────────────────────────────────────────

/** Prompts, answers, the session and turn rows, sourced messages. */
export function textSections(origin: string): GallerySection[] {
  const m = hydrate([
    { _id: "sys-1", kind: "system_init", provider: "claude", model: "claude-opus-4-1", tools: ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "mcp__linear__list_issues", "mcp__linear__create_issue", "CustomThing"], agents: ["general-purpose", "code-reviewer"], slashCommands: ["compact", "review", "init"], mcpServers: [{ name: "linear", status: "connected" }, { name: "sentry", status: "failed", error: "spawn ENOENT" }], debugRaw: JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-1" }) },
    { _id: "sys-2", kind: "system_init", provider: "claude", model: "claude-sonnet-4-5", tools: ["Bash"], agents: [], slashCommands: [], mcpServers: [] },
    { _id: "sys-3", kind: "system_init", provider: "codex", model: "gpt-5-codex", tools: ["shell", "apply_patch"], agents: [], slashCommands: [], mcpServers: [] },
    { _id: "sys-4", kind: "system_init", provider: "cursor", model: "auto", tools: [], agents: [], slashCommands: [], mcpServers: [] },
    { _id: "acct-1", kind: "account_info", accountInfo: { email: "demo@kanna.sh", organization: "Kanna", subscriptionType: "max" } },
    prompt("user-1", "Why does the sidebar flicker when I open a chat?"),
    prompt("user-2", "Here are the screenshot and my notes.", { attachments: chatAttachments(origin) }),
    prompt("user-3", LONG_PROMPT),
    prompt("user-4", "Actually, check the hover card first.", { steered: true }),
    prompt("user-5", "", { attachments: chatAttachments(origin).slice(0, 1) }),
    said("text-1", MARKDOWN_ANSWER),
    said("text-2", "A short answer, one line."),
    { _id: "status-1", kind: "status", status: "compacting" },
    { _id: "result-1", kind: "result", subtype: "success", isError: false, durationMs: 83_000, result: "Done" },
    { _id: "result-2", kind: "result", subtype: "error", isError: true, durationMs: 4_200, result: "API Error: 529 overloaded" },
    { _id: "result-3", kind: "result", subtype: "cancelled", isError: true, durationMs: 12_000, result: "" },
    { _id: "result-4", kind: "result", subtype: "success", isError: false, durationMs: 3_725_000, result: "Done" },
    { _id: "int-1", kind: "interrupted" },
    { _id: "cb-1", kind: "compact_boundary" },
    { _id: "cc-1", kind: "context_cleared" },
    { _id: "cs-1", kind: "compact_summary", summary: "## Summary\n\nThe user asked about the sidebar flicker. We found **two** renders on mount and fixed the observer." },
    call("todo-1", { kind: "tool", toolKind: "todo_write", toolName: "TodoWrite", toolId: "toolu_todo_1", input: { todos: [
      { content: "Reproduce the flicker", activeForm: "Reproducing the flicker", status: "completed" },
      { content: "Find the second render", activeForm: "Finding the second render", status: "in_progress" },
      { content: "Write a test", activeForm: "Writing a test", status: "pending" },
    ] } }),
    result("todo-1-r", "toolu_todo_1", "Todos have been modified successfully."),
    prompt("src-agent", "Please look at the flaky test in `socket.test.ts` and report back.", { source: { kind: "agent", chatId: "chat-parent" } }),
    prompt("src-schedule", "Run the nightly checks and summarise anything that failed.", { source: { kind: "schedule", scheduleId: "sched-1" } }),
    prompt("src-report", [
      "<system-message>Sub-chat completed: Flicker fix (chat id chat-a)</system-message>",
      "Fixed the double render. Tests pass.",
      "---",
      "<system-message>Sub-chat running: Socket test (chat id chat-b)</system-message>",
      "Still looking; the race is in reconnect.",
    ].join("\n"), { source: { kind: "report", chatIds: ["chat-a", "chat-b"] } }),
    prompt("src-adopted", "<system-message>Sub-chat adopted: Cleanup (chat id chat-c) was taken over by [Planner](/chat/chat-d), which adopted it.</system-message>", { source: { kind: "report", chatIds: ["chat-c"] } }),
  ])
  // An entry the transcript can't name draws as its JSON.
  const unknown: HydratedTranscriptMessage = { kind: "unknown", id: "unknown-1", timestamp: new Date(BASE_TIME).toISOString(), json: JSON.stringify({ type: "mystery", payload: { a: 1, b: [true, null] } }, null, 2) }
  return [
    {
      label: "Session",
      rows: [
        single(m.get("sys-1"), { isFirstSystem: true }),
        single(m.get("sys-2"), { isModelChange: true }),
        single(m.get("sys-3"), { handoff: { fromProvider: "claude", toProvider: "codex" } }),
        single(m.get("sys-4"), { restored: { provider: "cursor" } }),
        single(m.get("acct-1"), { isFirstAccount: true }),
        single(unknown),
      ],
    },
    {
      label: "Prompts",
      rows: [
        single(m.get("user-1")),
        single(m.get("user-2")),
        single(m.get("user-3")),
        single(m.get("user-4")),
        single(m.get("user-5")),
      ],
    },
    {
      label: "Answers",
      rows: [
        single(m.get("text-1")),
        single(m.get("text-2")),
        single(m.get("todo-1"), { isLatestTodoWrite: true }),
        single(m.get("status-1"), { isFinalStatus: true }),
        single(m.get("result-1"), { nextPromptTimestamp: new Date(BASE_TIME + 3_600_000).toISOString() }),
        single(m.get("result-2")),
        single(m.get("result-3")),
        single(m.get("result-4"), { nextPromptTimestamp: new Date(BASE_TIME + 60_000).toISOString(), nextPromptOrigin: "Schedule" }),
        single(m.get("int-1")),
        single(m.get("cb-1")),
        single(m.get("cc-1")),
        single(m.get("cs-1")),
      ],
    },
    {
      label: "Sent by others",
      rows: [
        single(m.get("src-agent")),
        single(m.get("src-schedule"), { showsOwnBoundary: true }),
        single(m.get("src-report")),
        single(m.get("src-adopted")),
      ],
    },
  ]
}

/** Queued messages under the transcript. */
export function queuedMessages(origin: string): QueuedChatMessage[] {
  return [
    { id: "queued-1", content: "And then run the full test suite.", attachments: [], createdAt: BASE_TIME },
    { id: "queued-2", content: "With this screenshot too.", attachments: chatAttachments(origin).slice(0, 2), createdAt: BASE_TIME },
    { id: "queued-3", content: "Please look at the flaky test and report back.", attachments: [], createdAt: BASE_TIME, source: { kind: "agent", chatId: "chat-parent" } },
    { id: "queued-4", content: LONG_PROMPT, attachments: [], createdAt: BASE_TIME },
  ]
}

/** A usage-limit resume, 42 minutes after the runner's frozen clock. */
export const USAGE_LIMIT_RESUME = { at: Date.UTC(2026, 5, 1, 12, 42, 0), provider: "claude" } as const

// ── Page: messages-tools ─────────────────────────────────────────────────

const READ_CONTENT = [
  "1→import { Effect } from \"effect\"",
  "2→",
  "3→export function main() {",
  "4→  return Effect.log(\"hello\")",
  "5→}",
].join("\n")

/** A 2×2 PNG, inline, as a Read of an image returns. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDKhcxAAAGOdBBEtJ2nMAAAAAElFTkSuQmCC"

/** Every tool kind the row special-cases, folded runs, and a subagent. */
export function toolSections(): GallerySection[] {
  const m = hydrate([
    call("bash-1", { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t-bash-1", input: { command: "bun test src/socket.test.ts", description: "Run the socket tests", timeoutMs: 120000, runInBackground: true } }),
    result("bash-1-r", "t-bash-1", "12 pass\n0 fail\nRan 12 tests across 1 file. [84.00ms]"),
    call("bash-2", { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t-bash-2", input: { command: "git status --short" } }),
    result("bash-2-r", "t-bash-2", "fatal: not a git repository", { isError: true }),
    call("read-1", { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t-read-1", input: { filePath: `${LOCAL_PATH}/src/app.ts` } }),
    result("read-1-r", "t-read-1", READ_CONTENT),
    call("read-2", { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t-read-2", input: { filePath: `${LOCAL_PATH}/docs/shot.png` } }),
    result("read-2-r", "t-read-2", [{ type: "image", source: { type: "base64", media_type: "image/png", data: TINY_PNG } }]),
    call("write-1", { kind: "tool", toolKind: "write_file", toolName: "Write", toolId: "t-write-1", input: { filePath: `${LOCAL_PATH}/src/new.ts`, content: "export const answer = 42\n" } }),
    result("write-1-r", "t-write-1", `File created successfully at: ${LOCAL_PATH}/src/new.ts`),
    call("edit-1", { kind: "tool", toolKind: "edit_file", toolName: "Edit", toolId: "t-edit-1", input: { filePath: `${LOCAL_PATH}/src/app.ts`, oldString: "export function main() {\n  return Effect.log(\"hello\")\n}", newString: "export function main() {\n  return Effect.log(\"hello, world\")\n}\n\nexport const version = 2" } }),
    result("edit-1-r", "t-edit-1", "The file has been updated successfully."),
    call("edit-2", { kind: "tool", toolKind: "edit_file", toolName: "Edit", toolId: "t-edit-2", input: { filePath: `${LOCAL_PATH}/src/missing.ts`, oldString: "a", newString: "b" } }),
    result("edit-2-r", "t-edit-2", "File does not exist.", { isError: true }),
    call("delete-1", { kind: "tool", toolKind: "delete_file", toolName: "Delete", toolId: "t-delete-1", input: { filePath: `${LOCAL_PATH}/src/old.ts`, content: "export const old = true\n" } }),
    result("delete-1-r", "t-delete-1", "Deleted."),
    call("grep-1", { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: "t-grep-1", input: { pattern: "useLayoutEffect", outputMode: "content" } }),
    result("grep-1-r", "t-grep-1", "src/app.ts:12: useLayoutEffect(() => {"),
    call("grep-2", { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: "t-grep-2", input: { pattern: "TODO", outputMode: "count" } }),
    result("grep-2-r", "t-grep-2", "7"),
    call("glob-1", { kind: "tool", toolKind: "glob", toolName: "Glob", toolId: "t-glob-1", input: { pattern: "**/*.test.ts" } }),
    result("glob-1-r", "t-glob-1", "src/a.test.ts\nsrc/b.test.ts"),
    call("glob-2", { kind: "tool", toolKind: "glob", toolName: "Glob", toolId: "t-glob-2", input: { pattern: "**/*" } }),
    result("glob-2-r", "t-glob-2", "…"),
    call("web-1", { kind: "tool", toolKind: "web_search", toolName: "WebSearch", toolId: "t-web-1", input: { query: "effect 4 stream callback" } }),
    result("web-1-r", "t-web-1", { results: [{ title: "Stream.callback", url: "https://effect.website" }] }),
    call("skill-1", { kind: "tool", toolKind: "skill", toolName: "Skill", toolId: "t-skill-1", input: { skill: "release" } }),
    result("skill-1-r", "t-skill-1", "Loaded."),
    call("mcp-1", { kind: "tool", toolKind: "mcp_generic", toolName: "mcp__linear__list_issues", toolId: "t-mcp-1", input: { server: "linear", tool: "list_issues", payload: { team: "KAN" } } }),
    result("mcp-1-r", "t-mcp-1", [{ type: "text", text: "KAN-12 Flicker on open" }]),
    call("unknown-1", { kind: "tool", toolKind: "unknown_tool", toolName: "NotebookEdit", toolId: "t-unknown-1", input: { payload: { cell: 3 } } }),
    result("unknown-1-r", "t-unknown-1", "ok"),
    call("chat-1", { kind: "tool", toolKind: "chat", toolName: "create_chat", toolId: "t-chat-1", input: { payload: { title: "Fix the flicker", message: "Find why the sidebar renders twice on mount and fix it." } } }),
    result("chat-1-r", "t-chat-1", { chatId: "chat-a", title: "Flicker fix" }),
    call("chat-2", { kind: "tool", toolKind: "chat", toolName: "send_message", toolId: "t-chat-2", input: { payload: { chatId: "chat-a", message: "Also check the hover card." } } }),
    result("chat-2-r", "t-chat-2", { chatId: "chat-a", started: false }),
    call("chat-3", { kind: "tool", toolKind: "chat", toolName: "fork_chat", toolId: "t-chat-3", input: { payload: { chatId: "chat-a", title: "Try the other approach" } } }),
    call("chat-4", { kind: "tool", toolKind: "chat", toolName: "send_message", toolId: "t-chat-4", input: { payload: { chatId: "chat-z", message: "Hello?" } } }),
    result("chat-4-r", "t-chat-4", [{ type: "text", text: "No chat chat-z." }], { isError: true }),
    call("sched-1", { kind: "tool", toolKind: "schedule", toolName: "set_schedule", toolId: "t-sched-1", input: { payload: { name: "Nightly checks", message: "Run the nightly checks.", dailyAt: "09:30", weekdays: [1, 2, 3, 4, 5] } } }),
    result("sched-1-r", "t-sched-1", { scheduleId: "sched-1", name: "Nightly checks" }),
    call("sched-2", { kind: "tool", toolKind: "schedule", toolName: "set_schedule", toolId: "t-sched-2", input: { payload: { scheduleId: "sched-2", message: "Check the deploy.", everyMinutes: 30 } } }),
    result("sched-2-r", "t-sched-2", { scheduleId: "sched-2" }),
    call("sched-3", { kind: "tool", toolKind: "schedule", toolName: "delete_schedule", toolId: "t-sched-3", input: { payload: { scheduleId: "sched-3" } } }),
    result("sched-3-r", "t-sched-3", { deleted: "sched-3" }),
    call("sched-4", { kind: "tool", toolKind: "schedule", toolName: "set_schedule", toolId: "t-sched-4", input: { payload: { message: "Remind me about the release.", inMinutes: 45 } } }),
    call("sched-5", { kind: "tool", toolKind: "schedule", toolName: "set_schedule", toolId: "t-sched-5", input: { payload: { message: "x", everyMinutes: 1 } } }),
    result("sched-5-r", "t-sched-5", [{ type: "text", text: "Intervals under five minutes are not allowed." }], { isError: true }),
    call("pending-1", { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t-pending-1", input: { command: "bun run build", description: "Build the client" } }),
    call("agent-1", { kind: "tool", toolKind: "subagent_task", toolName: "Task", toolId: "t-agent-1", input: { subagentType: "Explore", description: "Find the flicker", prompt: "Look through src/client for anything that renders twice on mount.\n\nReport file and line." } }),
    { _id: "agent-1-text", kind: "assistant_text", text: "Looking at the sidebar first.", parentToolUseId: "t-agent-1" },
    call("agent-1-grep", { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: "t-agent-1-grep", input: { pattern: "useLayoutEffect" } }, { parentToolUseId: "t-agent-1" }),
    { _id: "agent-1-grep-r", kind: "tool_result", toolId: "t-agent-1-grep", content: "src/app.ts", parentToolUseId: "t-agent-1" },
    result("agent-1-r", "t-agent-1", [{ type: "text", text: "## Findings\n\nThe double render is in `src/app.ts:12`." }]),
    call("agent-2", { kind: "tool", toolKind: "subagent_task", toolName: "Task", toolId: "t-agent-2", input: { description: "Broken agent" } }),
    result("agent-2-r", "t-agent-2", "Agent crashed", { isError: true }),
    // A folded run of reads and greps.
    call("g1-a", { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t-g1-a", input: { filePath: `${LOCAL_PATH}/src/a.ts` } }),
    result("g1-a-r", "t-g1-a", "1→a"),
    call("g1-b", { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t-g1-b", input: { filePath: `${LOCAL_PATH}/src/b.ts` } }),
    result("g1-b-r", "t-g1-b", "1→b"),
    call("g1-c", { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: "t-g1-c", input: { pattern: "flicker" } }),
    result("g1-c-r", "t-g1-c", "none"),
    // A run of more than five, with Collapse at its foot, one still going.
    ...[1, 2, 3, 4, 5, 6].flatMap((index): Draft[] => [
      call(`g2-${index}`, index % 2 === 0
        ? { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: `t-g2-${index}`, input: { command: `echo ${index}` } }
        : { kind: "tool", toolKind: "edit_file", toolName: "Edit", toolId: `t-g2-${index}`, input: { filePath: `${LOCAL_PATH}/src/f${index}.ts`, oldString: "x", newString: "y" } }),
      ...(index < 6 ? [result(`g2-${index}-r`, `t-g2-${index}`, "ok")] : []),
    ]),
  ])
  return [
    {
      label: "Commands and files",
      rows: [
        single(m.get("bash-1")),
        single(m.get("bash-2")),
        single(m.get("read-1")),
        single(m.get("read-2")),
        single(m.get("write-1")),
        single(m.get("edit-1")),
        single(m.get("edit-2")),
        single(m.get("delete-1")),
      ],
    },
    {
      label: "Searches and others",
      rows: [
        single(m.get("grep-1")),
        single(m.get("grep-2")),
        single(m.get("glob-1")),
        single(m.get("glob-2")),
        single(m.get("web-1")),
        single(m.get("skill-1")),
        single(m.get("mcp-1")),
        single(m.get("unknown-1")),
        single(m.get("pending-1"), { isLoading: true }),
      ],
    },
    {
      label: "Chats and schedules",
      rows: [
        single(m.get("chat-1")),
        single(m.get("chat-2")),
        single(m.get("chat-3"), { isLoading: true }),
        single(m.get("chat-4")),
        single(m.get("sched-1")),
        single(m.get("sched-2")),
        single(m.get("sched-3")),
        single(m.get("sched-4"), { isLoading: true }),
        single(m.get("sched-5")),
      ],
    },
    {
      label: "Agents",
      rows: [
        single(m.get("agent-1")),
        single(m.get("agent-2")),
      ],
    },
    {
      label: "Folded runs",
      rows: [
        group([m.get("g1-a"), m.get("g1-b"), m.get("g1-c")]),
        group([1, 2, 3, 4, 5, 6].map((index) => m.get(`g2-${index}`)), true),
      ],
    },
  ]
}

// ── Page: messages-questions ─────────────────────────────────────────────

const QUESTIONS = [
  {
    question: "Which approach should I take for the flicker fix?",
    header: "Approach",
    options: [
      { label: "Memoize the row", description: "Smallest change; keeps the observer." },
      { label: "Drop the observer", description: "Measure once on mount instead." },
    ],
  },
  {
    question: "Which platforms should I test?",
    header: "Platforms",
    multiSelect: true,
    options: [
      { label: "macOS" },
      { label: "Linux" },
      { label: "Windows", description: "Through the VM." },
    ],
  },
]

const PLAN = [
  "# Fix the sidebar flicker",
  "",
  "1. Reproduce it in a test with two renders on mount.",
  "2. Replace the `ResizeObserver` with a one-off measure.",
  "3. Run the sidebar scenarios.",
  "",
  "```ts",
  "const width = element.clientWidth",
  "```",
  "",
  ...Array.from({ length: 24 }, (_, index) => `- Detail ${index + 1}: a line to make the plan long enough to fold.`),
].join("\n")

/** AskUserQuestion and ExitPlanMode in each of their states. */
export function questionSections(): GallerySection[] {
  const ask = (id: string, questions = QUESTIONS): Draft => call(id, { kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: `t-${id}`, input: { questions } })
  const plan = (id: string, text: string | undefined = PLAN): Draft => call(id, { kind: "tool", toolKind: "exit_plan_mode", toolName: "ExitPlanMode", toolId: `t-${id}`, input: text === undefined ? {} : { plan: text } })
  const m = hydrate([
    ask("ask-live"),
    ask("ask-answered"),
    result("ask-answered-r", "t-ask-answered", "answered", { structuredResult: { answers: { [QUESTIONS[0]!.question]: ["Memoize the row"], [QUESTIONS[1]!.question]: ["macOS", "Linux"] } } }),
    ask("ask-discarded"),
    result("ask-discarded-r", "t-ask-discarded", "discarded", { structuredResult: { answers: {}, discarded: true } }),
    ask("ask-stale"),
    ask("ask-single", [QUESTIONS[0]!]),
    plan("plan-live"),
    plan("plan-approved"),
    result("plan-approved-r", "t-plan-approved", "ok", { structuredResult: { confirmed: true } }),
    plan("plan-cleared"),
    result("plan-cleared-r", "t-plan-cleared", "ok", { structuredResult: { confirmed: true, clearContext: true } }),
    plan("plan-adjusted", "Short plan."),
    result("plan-adjusted-r", "t-plan-adjusted", "ok", { structuredResult: { confirmed: false, message: "Test on Linux too" } }),
    plan("plan-discarded", "Short plan."),
    result("plan-discarded-r", "t-plan-discarded", "ok", { structuredResult: { discarded: true } }),
    plan("plan-stale", "A plan that a newer prompt made stale."),
    plan("plan-empty", undefined),
  ])
  return [
    {
      label: "Questions",
      rows: [
        single(m.get("ask-live"), { isLatestAskUserQuestion: true }),
        single(m.get("ask-answered")),
        single(m.get("ask-discarded")),
        single(m.get("ask-stale")),
      ],
    },
    {
      label: "Plans",
      rows: [
        single(m.get("plan-live"), { isLatestExitPlanMode: true }),
        single(m.get("plan-approved")),
        single(m.get("plan-cleared")),
        single(m.get("plan-adjusted")),
        single(m.get("plan-discarded")),
        single(m.get("plan-stale")),
        single(m.get("plan-empty")),
      ],
    },
  ]
}

/** The same question and plan in an export: nothing to answer. */
export function readonlySections(): GallerySection[] {
  const m = hydrate([
    call("ro-ask", { kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: "t-ro-ask", input: { questions: [QUESTIONS[0]!] } }),
    call("ro-plan", { kind: "tool", toolKind: "exit_plan_mode", toolName: "ExitPlanMode", toolId: "t-ro-plan", input: { plan: "Short plan." } }),
  ])
  return [{
    label: "Read-only",
    rows: [
      single(m.get("ro-ask"), { isLatestAskUserQuestion: true }),
      single(m.get("ro-plan"), { isLatestExitPlanMode: true }),
    ],
  }]
}

// ── Page: messages-display ───────────────────────────────────────────────

const SALES = [
  { month: "Jan", desktop: 186, mobile: 80 },
  { month: "Feb", desktop: 305, mobile: 200 },
  { month: "Mar", desktop: 237, mobile: 120 },
  { month: "Apr", desktop: 73, mobile: 190 },
  { month: "May", desktop: 209, mobile: 130 },
  { month: "Jun", desktop: 214, mobile: 140 },
]

export const CHARTS: ReadonlyArray<ChartToolPayload> = [
  { title: "Visitors by month", description: "Desktop and mobile, first half of 2026", type: "bar", data: SALES, xKey: "month", yKeys: ["desktop", "mobile"] },
  { title: "Stacked visitors", type: "bar", data: SALES, xKey: "month", yKeys: ["desktop", "mobile"], stacked: true, config: { desktop: { label: "Desktop" }, mobile: { label: "Mobile", color: "#00bd7c" } } },
  { title: "Visitors over time", type: "line", data: SALES, xKey: "month", yKeys: ["desktop", "mobile"] },
  { title: "Revenue", description: "In dollars", type: "area", data: [
    { quarter: "Q1", revenue: 12_400, cost: 8_100 },
    { quarter: "Q2", revenue: 18_900, cost: 9_300 },
    { quarter: "Q3", revenue: 15_200, cost: 11_000 },
    { quarter: "Q4", revenue: 24_700, cost: 12_500 },
  ], xKey: "quarter", yKeys: ["revenue", "cost"] },
  { title: "Browser share", type: "pie", data: [
    { browser: "Chrome", share: 61.2 },
    { browser: "Safari", share: 19.8 },
    { browser: "Firefox", share: 6.4 },
    { browser: "Edge", share: 5.1 },
    { browser: "Other", share: 7.5 },
  ], xKey: "browser", yKeys: ["share"] },
  { title: "Nothing yet", type: "bar", data: [] },
]

/** Display tools: attachments in their shapes, charts. */
export function displaySections(origin: string): GallerySection[] {
  const attachment = (name: string, kind: "image" | "video" | "file", path: string, mimeType: string) => ({ type: "attachment", url: `${origin}${path}`, name, kind, mimeType, size: 1024 })
  const display = (id: string, toolName: string, payload: Record<string, unknown>): Draft => call(id, { kind: "tool", toolKind: "display", toolName, toolId: `t-${id}`, input: { payload } })
  const m = hydrate([
    display("att-one", "send_attachments", {}),
    result("att-one-r", "t-att-one", [attachment("screenshot-light.png", "image", "/screenshot-light.png", "image/png")]),
    display("att-many", "send_attachments", {}),
    result("att-many-r", "t-att-many", [
      attachment("icon-512.png", "image", "/icon-512.png", "image/png"),
      attachment("apple-touch-icon.png", "image", "/apple-touch-icon.png", "image/png"),
      attachment("screenshot-light.png", "image", "/screenshot-light.png", "image/png"),
      attachment("icon-192.png", "image", "/icon-192.png", "image/png"),
      attachment("favicon.png", "image", "/favicon.png", "image/png"),
    ]),
    display("att-files", "send_attachments", {}),
    result("att-files-r", "t-att-files", [
      attachment("report.pdf", "file", "/report.pdf", "application/pdf"),
      attachment("data with a long file name.csv", "file", "/data.csv", "text/csv"),
    ]),
    display("att-broken", "send_attachments", {}),
    result("att-broken-r", "t-att-broken", [attachment("missing.png", "image", "/missing-image.png", "image/png")]),
    display("att-pending", "generate_images", {}),
    display("att-error", "send_attachments", {}),
    result("att-error-r", "t-att-error", [{ type: "text", text: "The file is outside the project." }], { isError: true }),
    display("viz-pending", "show_visualization", {}),
    // The fixture backend answers /api with a 404: the frame says it could not load.
    display("viz-missing", "show_visualization", {}),
    result("viz-missing-r", "t-viz-missing", [{ type: "visualization", version: 1, title: "Flicker timeline", url: "/api/chats/demo/media/visualization-flicker.html", height: 240 }]),
    display("viz-bad", "show_visualization", {}),
    result("viz-bad-r", "t-viz-bad", [{ type: "visualization", version: 1, title: "Elsewhere", url: "https://example.com/v.html", height: 240 }]),
    display("chart-pending", "show_chart", {}),
    ...CHARTS.flatMap((chart, index): Draft[] => [
      display(`chart-${index}`, "show_chart", chart as unknown as Record<string, unknown>),
      result(`chart-${index}-r`, `t-chart-${index}`, [{ type: "text", text: "Chart shown." }]),
    ]),
  ])
  return [
    {
      label: "Attachments",
      rows: [
        single(m.get("att-one")),
        single(m.get("att-many")),
        single(m.get("att-files")),
        single(m.get("att-broken")),
        single(m.get("att-pending"), { isLoading: true }),
        single(m.get("att-error")),
        single(m.get("viz-pending"), { isLoading: true }),
        single(m.get("viz-missing")),
        single(m.get("viz-bad")),
        single(m.get("chart-pending"), { isLoading: true }),
      ],
    },
    {
      label: "Charts",
      rows: CHARTS.map((_, index) => single(m.get(`chart-${index}`))),
    },
  ]
}

/** Every row of a page, in order, for a host that wants them flat. */
export function allRows(sections: ReadonlyArray<GallerySection>): TranscriptRow[] {
  return sections.flatMap((section) => section.rows)
}
