import type { StandaloneTranscriptBundle, TranscriptEntry } from "../../../shared/types"

// A standalone export for the export viewer's parity pages
// (src/parity/{react,foldkit}/gallery/transcript-export-viewer): two turns,
// long enough to scroll, with what an export draws as text (a local file
// link, a link to another chat) and a run of tool calls.

/** An hour before the runner's frozen clock (2026-06-01T12:00Z), a second apart. */
const BASE_TIME = Date.UTC(2026, 5, 1, 11, 0, 0)

const SOURCE_ORIGIN = "http://kanna.example:5174"
const LOCAL_PATH = "/Users/demo/code/tidepool"

type Draft = TranscriptEntry extends infer T ? T extends TranscriptEntry ? Omit<T, "createdAt"> : never : never

const READ_UNITS = [
  "1→export function formatFeet(meters: number) {",
  "2→  return `${(meters * 3.28084).toFixed(1)} ft`",
  "3→}",
].join("\n")

const DRAFTS: Draft[] = [
  { _id: "x-init", kind: "system_init", provider: "claude", model: "claude-opus-4-1", tools: ["Read", "Edit", "Bash", "Grep"], agents: [], slashCommands: [], mcpServers: [] } as unknown as Draft,
  { _id: "x-p1", kind: "user_prompt", content: "The forecast card only shows wave height in feet. Add a toggle so people can switch to meters, and remember their choice." },
  { _id: "x-t1", kind: "assistant_text", text: "I'll start with how the card formats heights today." },
  { _id: "x-c1", kind: "tool_call", tool: { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: "t-x-grep", input: { pattern: "formatFeet", outputMode: "content" } } } as Draft,
  { _id: "x-r1", kind: "tool_result", toolId: "t-x-grep", content: "src/lib/units.ts:1: export function formatFeet(meters: number) {\nsrc/components/ForecastCard.tsx:14:   {formatFeet(wave.height)}" },
  { _id: "x-c2", kind: "tool_call", tool: { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: "t-x-read", input: { filePath: `${LOCAL_PATH}/src/lib/units.ts` } } } as Draft,
  { _id: "x-r2", kind: "tool_result", toolId: "t-x-read", content: READ_UNITS },
  { _id: "x-c3", kind: "tool_call", tool: { kind: "tool", toolKind: "edit_file", toolName: "Edit", toolId: "t-x-edit", input: { filePath: `${LOCAL_PATH}/src/lib/units.ts`, oldString: "export function formatFeet(meters: number) {", newString: "export function formatHeight(meters: number, unit: HeightUnit) {" } } } as Draft,
  { _id: "x-r3", kind: "tool_result", toolId: "t-x-edit", content: "The file has been updated successfully." },
  { _id: "x-c4", kind: "tool_call", tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t-x-bash", input: { command: "bun test src/lib", description: "Run the units tests" } } } as Draft,
  { _id: "x-r4", kind: "tool_result", toolId: "t-x-bash", content: "4 pass\n0 fail\nRan 4 tests across 1 file. [12.00ms]" },
  {
    _id: "x-t2",
    kind: "assistant_text",
    text: [
      "Wave heights now switch between feet and meters, and the choice survives a reload.",
      "",
      `- **formatHeight** replaces \`formatFeet\` in [src/lib/units.ts](${LOCAL_PATH}/src/lib/units.ts) and takes the unit to show.`,
      "- **useHeightUnit** keeps the choice in `localStorage`.",
      "- **ForecastCard** has a small ft/m button beside the height.",
      "",
      "```ts",
      "export function formatHeight(meters: number, unit: HeightUnit) {",
      "  return unit === \"m\" ? `${meters.toFixed(1)} m` : `${(meters * 3.28084).toFixed(1)} ft`",
      "}",
      "```",
      "",
      `The swell arrow is still to do; I started [a chat for it](${SOURCE_ORIGIN}/chat/chat-swell).`,
    ].join("\n"),
  },
  { _id: "x-res1", kind: "result", subtype: "success", isError: false, durationMs: 19_000, result: "" } as unknown as Draft,
  { _id: "x-p2", kind: "user_prompt", content: "Now show the swell direction as an arrow next to the height." },
  { _id: "x-t3", kind: "assistant_text", text: "The forecast already carries a swell direction in degrees, so the arrow is a rotated glyph." },
  { _id: "x-c5", kind: "tool_call", tool: { kind: "tool", toolKind: "write_file", toolName: "Write", toolId: "t-x-write", input: { filePath: `${LOCAL_PATH}/src/components/SwellArrow.tsx`, content: "export function SwellArrow({ degrees }: { degrees: number }) {\n  return <span style={{ transform: `rotate(${degrees}deg)` }}>↑</span>\n}\n" } } } as Draft,
  { _id: "x-r5", kind: "tool_result", toolId: "t-x-write", content: `File created successfully at: ${LOCAL_PATH}/src/components/SwellArrow.tsx` },
  {
    _id: "x-t4",
    kind: "assistant_text",
    text: [
      "Added `SwellArrow` beside the height. It rotates with the swell, pointing where the waves travel.",
      "",
      "1. The arrow sits after the unit toggle, so the two read as one group.",
      "2. Screen readers hear the direction as a compass point, not a rotation.",
      "3. Missing directions draw nothing rather than an arrow pointing north.",
      "",
      "Let me know if you'd rather have the compass letters than the glyph.",
    ].join("\n"),
  },
  { _id: "x-res2", kind: "result", subtype: "success", isError: false, durationMs: 42_000, result: "" } as unknown as Draft,
]

export function exportFixtureBundle(): StandaloneTranscriptBundle {
  return {
    sourceOrigin: SOURCE_ORIGIN,
    version: 1,
    chatId: "chat-export-units",
    title: "Add a feet/meters toggle",
    localPath: LOCAL_PATH,
    exportedAt: new Date(BASE_TIME + 3_600_000).toISOString(),
    viewerVersion: "0.0.0",
    theme: "dark",
    attachmentMode: "metadata",
    messages: DRAFTS.map((draft, index) => ({ ...draft, createdAt: BASE_TIME + (index + 1) * 1000 }) as TranscriptEntry),
  }
}
