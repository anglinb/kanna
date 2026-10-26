import { normalizeToolCall } from "../../shared/tools"
import type { SubagentActivity, TranscriptEntry, WorkflowAgent, WorkflowAgentState, WorkflowProgress } from "../../shared/types"

// The gallery's made-up data (WorkflowsGalleryPage.tsx's buildData and its
// live run's plan), copied: a React file.

const SECOND = 1_000
const MINUTE = 60 * SECOND

export function agent(index: number, label: string, state: WorkflowAgentState, extra: Partial<WorkflowAgent> = {}): WorkflowAgent {
  return { index, label, state, ...extra }
}

export function buildData(t0: number) {
  const ago = (ms: number) => t0 - ms

  const poemPhases = [{ index: 1, title: "Draft" }, { index: 2, title: "Score" }, { index: 3, title: "Synthesize" }]

  const midRun: WorkflowProgress = {
    name: "poem-tournament",
    phases: poemPhases,
    agents: [
      agent(1, "draft:sonnet", "done", {
        phaseIndex: 1, model: "claude-sonnet-5", tokens: 8_400, toolCalls: 3,
        startedAt: ago(4 * MINUTE), lastProgressAt: ago(3 * MINUTE),
        promptPreview: "Write a sonnet about a lighthouse keeper who has never seen the sea.",
        resultPreview: "Upon the rock where salt winds never reach, a keeper tends a flame for ships unseen…",
      }),
      agent(2, "draft:limerick", "done", { phaseIndex: 1, model: "claude-haiku-4-5", tokens: 2_100, toolCalls: 1, startedAt: ago(4 * MINUTE), lastProgressAt: ago(3.5 * MINUTE) }),
      agent(3, "draft:haiku", "done", { phaseIndex: 1, cached: true, startedAt: ago(4 * MINUTE), lastProgressAt: ago(4 * MINUTE) }),
      agent(4, "score:potential", "done", { phaseIndex: 2, model: "claude-opus-5-5", tokens: 12_900, toolCalls: 0, startedAt: ago(2.5 * MINUTE), lastProgressAt: ago(2.1 * MINUTE) }),
      agent(5, "score:freshness", "running", {
        phaseIndex: 2, model: "claude-opus-5-5", tokens: 6_300, toolCalls: 2, startedAt: ago(105 * SECOND),
        promptPreview: "Score each draft 1–10 for freshness of imagery. Penalise cliché. Return JSON.",
      }),
      agent(6, "score:rhythm", "queued", { phaseIndex: 2 }),
      agent(7, "synthesize", "queued", { phaseIndex: 3 }),
    ],
  }

  const completed: WorkflowProgress = {
    name: "review-changes",
    phases: [{ index: 1, title: "Review" }, { index: 2, title: "Verify" }],
    agents: [
      agent(1, "review:bugs", "done", { phaseIndex: 1, tokens: 22_000, toolCalls: 14, startedAt: ago(9 * MINUTE), lastProgressAt: ago(6 * MINUTE) }),
      agent(2, "review:perf", "done", { phaseIndex: 1, tokens: 17_500, toolCalls: 9, startedAt: ago(9 * MINUTE), lastProgressAt: ago(7 * MINUTE) }),
      agent(3, "verify:ws-router.ts:1866", "done", { phaseIndex: 2, tokens: 4_000, toolCalls: 3, startedAt: ago(6 * MINUTE), lastProgressAt: ago(5 * MINUTE) }),
      agent(4, "verify:agent.ts:1290", "done", { phaseIndex: 2, tokens: 3_600, toolCalls: 2, startedAt: ago(6 * MINUTE), lastProgressAt: ago(5.5 * MINUTE) }),
    ],
  }

  const failed: WorkflowProgress = {
    name: "spec",
    phases: [{ index: 1, title: "Research" }, { index: 2, title: "Write" }],
    agents: [
      agent(1, "research:sdk", "done", { phaseIndex: 1, tokens: 15_000, toolCalls: 8, startedAt: ago(8 * MINUTE), lastProgressAt: ago(6 * MINUTE) }),
      agent(2, "research:cli", "failed", {
        phaseIndex: 1, tokens: 9_800, toolCalls: 5, startedAt: ago(8 * MINUTE), lastProgressAt: ago(5 * MINUTE),
        error: "Agent exceeded its turn budget without returning a result.",
      }),
      agent(3, "write:spec", "skipped", { phaseIndex: 2 }),
      agent(4, "write:tests", "skipped", { phaseIndex: 2 }),
    ],
  }

  const stopped: WorkflowProgress = {
    name: "migrate-schema",
    phases: [{ index: 1, title: "Plan" }, { index: 2, title: "Migrate" }],
    agents: [
      agent(1, "plan", "done", { phaseIndex: 1, tokens: 5_200, toolCalls: 4, startedAt: ago(5 * MINUTE), lastProgressAt: ago(4 * MINUTE) }),
      agent(2, "migrate:users", "failed", { phaseIndex: 2, tokens: 3_000, toolCalls: 2, startedAt: ago(4 * MINUTE), lastProgressAt: ago(3 * MINUTE) }),
      agent(3, "migrate:chats", "skipped", { phaseIndex: 2 }),
    ],
  }

  const unphased: WorkflowProgress = {
    name: "fan-out",
    phases: [],
    agents: [
      agent(1, "summarize:README.md", "done", { tokens: 1_200, startedAt: ago(40 * SECOND), lastProgressAt: ago(20 * SECOND) }),
      agent(2, "summarize:CLAUDE.md", "running", { tokens: 800, startedAt: ago(30 * SECOND) }),
      agent(3, "summarize:package.json", "queued", {}),
    ],
  }

  const states: WorkflowAgentState[] = ["done", "done", "done", "running", "queued", "failed", "done", "skipped"]
  const large: WorkflowProgress = {
    name: "audit-every-file",
    phases: [{ index: 1, title: "Audit" }],
    agents: Array.from({ length: 230 }, (_, i) => agent(i + 1, `audit:src/file-${i + 1}.ts`, i < 150 ? "done" : states[i % states.length]!, {
      phaseIndex: 1, tokens: 1_000 + i * 10, startedAt: ago(10 * MINUTE),
      ...(i < 150 ? { lastProgressAt: ago(5 * MINUTE) } : {}),
    })),
  }

  const workflow = (id: string, progress: WorkflowProgress, extra: Partial<SubagentActivity> = {}): SubagentActivity => ({
    id,
    type: "workflow",
    label: progress.name ?? "Workflow",
    status: "running",
    startedAt: ago(5 * MINUTE),
    stoppable: true,
    toolUseId: `toolu_${id}`,
    workflow: progress,
    ...extra,
  })

  const workflows = {
    starting: workflow("wf-starting", { name: "dependency-sweep", phases: [], agents: [] }, { startedAt: ago(3 * SECOND) }),
    midRun: workflow("wf-mid", midRun),
    stopping: workflow("wf-stopping", { ...midRun, name: "poem-tournament (stopping)" }),
    notStoppable: workflow("wf-unstoppable", { ...midRun, name: "found-by-the-sweep" }, { stoppable: undefined, toolUseId: undefined }),
    second: workflow("wf-second", unphased, { startedAt: ago(40 * SECOND) }),
    completed: workflow("wf-completed", completed, { status: "completed", startedAt: ago(9 * MINUTE), endedAt: ago(5 * MINUTE), summary: "2 findings confirmed, 1 rejected." }),
    failed: workflow("wf-failed", failed, { status: "failed", startedAt: ago(8 * MINUTE), endedAt: ago(5 * MINUTE) }),
    stopped: workflow("wf-stopped", stopped, { status: "stopped", startedAt: ago(5 * MINUTE), endedAt: ago(3 * MINUTE) }),
    unphased: workflow("wf-unphased", unphased, { startedAt: ago(45 * SECOND) }),
    large: workflow("wf-large", large, { startedAt: ago(10 * MINUTE) }),
  }

  const task = (id: string, type: string, label: string, status: SubagentActivity["status"], startedAgo: number, extra: Partial<SubagentActivity> = {}): SubagentActivity => ({
    id,
    type,
    label,
    status,
    startedAt: ago(startedAgo),
    ...(status === "running" ? {} : { endedAt: ago(Math.max(0, startedAgo - 30 * SECOND)) }),
    ...extra,
  })

  const log: SubagentActivity[] = [
    task("monitor-running", "monitor", "Watch the deploy log for errors", "running", 12 * MINUTE, {
      description: "Watch the deploy log for errors", summary: "Last match 2m ago", stoppable: true, toolUseId: "toolu_monitor",
    }),
    task("agent-running", "subagent", "general-purpose", "running", 2 * MINUTE, {
      description: "Audit durable.ts turn engine", stoppable: true, toolUseId: "toolu_agent", usage: { totalTokens: 18_400, toolUses: 6 },
    }),
    workflows.midRun,
    task("shell-running", "shell", "bun test --watch", "running", 6 * MINUTE, { description: "Run the tests on change", stoppable: true }),
    task("agent-stopping", "subagent", "Explore", "running", 90 * SECOND, { description: "Find every caller of stopTask", stoppable: true }),
    task("cloud-running", "cloud session", "Nightly build", "running", 20 * MINUTE, { description: "Nightly build on the remote box" }),
    task("agent-done", "subagent", "Explore", "completed", 7 * MINUTE, { description: "Find the websocket reconnect path", usage: { totalTokens: 9_100, toolUses: 12 } }),
    task("agent-failed", "subagent", "general-purpose", "failed", 9 * MINUTE, { description: "Migrate the chats table" }),
    task("monitor-stopped", "monitor", "Poll CI for #138", "stopped", 15 * MINUTE, { description: "Poll CI for #138" }),
    task("monitor-done", "monitor", "Wait for the tunnel to come up", "completed", 16 * MINUTE, { description: "Wait for the tunnel to come up", summary: "Tunnel up at 13:02" }),
    task("monitor-failed", "monitor", "Tail the worker's stderr", "failed", 17 * MINUTE, { description: "Tail the worker's stderr" }),
    task("shell-done", "shell", "bun run build", "completed", 18 * MINUTE, { description: "Build the client" }),
    workflows.completed,
    workflows.failed,
    workflows.stopped,
    task("mcp-done", "MCP task", "Export the Figma frames", "completed", 25 * MINUTE, { description: "Export the Figma frames", summary: "12 frames exported" }),
    task("teammate-done", "teammate", "Reviewer", "completed", 30 * MINUTE, { description: "Review the migration plan" }),
  ]

  // The subagent row whose spawn call is in the "transcript", so its card is the full agent card.
  const entries: TranscriptEntry[] = [
    {
      _id: "e-spawn", createdAt: ago(2 * MINUTE), kind: "tool_call",
      tool: normalizeToolCall({
        toolName: "Agent",
        toolId: "toolu_agent",
        input: {
          subagent_type: "general-purpose",
          description: "Audit durable.ts turn engine",
          prompt: "Read src/server/durable.ts end to end. List every place a turn can end without its result being recorded, with line numbers, and say which are reachable.",
        },
      }),
    } as TranscriptEntry,
    {
      _id: "e-step-1", createdAt: ago(100 * SECOND), kind: "tool_call", parentToolUseId: "toolu_agent",
      tool: normalizeToolCall({ toolName: "Read", toolId: "toolu_read", input: { file_path: "/repo/src/server/durable.ts" } }),
    } as TranscriptEntry,
    { _id: "e-step-2", createdAt: ago(80 * SECOND), kind: "assistant_text", text: "Three exits so far.", parentToolUseId: "toolu_agent" } as TranscriptEntry,
    {
      _id: "e-step-3", createdAt: ago(60 * SECOND), kind: "tool_call", parentToolUseId: "toolu_agent",
      tool: normalizeToolCall({ toolName: "Grep", toolId: "toolu_grep", input: { pattern: "recordTurn" } }),
    } as TranscriptEntry,
    {
      _id: "e-monitor", createdAt: ago(12 * MINUTE), kind: "tool_call",
      tool: normalizeToolCall({ toolName: "Monitor", toolId: "toolu_monitor", input: { description: "Watch the deploy log for errors" } }),
    } as TranscriptEntry,
    {
      _id: "e-workflow", createdAt: ago(5 * MINUTE), kind: "tool_call",
      tool: normalizeToolCall({ toolName: "Workflow", toolId: "toolu_wf-mid", input: {} }),
    } as TranscriptEntry,
  ]

  return { workflows, log, entries, ago }
}

/**
 * One run, played on a loop: agents announced as their phase starts, queued,
 * running, then done or failed, then the run completes and starts over.
 */
export const LIVE_TICK_MS = 1_200
const LIVE_PLAN = [
  { index: 1, phase: 1, label: "draft:sonnet", announce: 0, start: 1, end: 4 },
  { index: 2, phase: 1, label: "draft:limerick", announce: 0, start: 1, end: 5 },
  { index: 3, phase: 1, label: "draft:haiku", announce: 0, start: 2, end: 6 },
  { index: 4, phase: 1, label: "draft:free-verse", announce: 0, start: 2, end: 5, failed: true },
  { index: 5, phase: 2, label: "score:potential", announce: 6, start: 7, end: 9 },
  { index: 6, phase: 2, label: "score:freshness", announce: 6, start: 7, end: 11 },
  { index: 7, phase: 2, label: "score:rhythm", announce: 6, start: 8, end: 10 },
  { index: 8, phase: 3, label: "synthesize", announce: 12, start: 12, end: 15 },
]
const LIVE_DONE_AT = 16
export const LIVE_LOOP_AT = 20

/** The live run at a step of its loop. */
export function liveWorkflow(step: number, runStart: number): SubagentActivity {
  const at = (tick: number) => runStart + tick * LIVE_TICK_MS
  const agents = LIVE_PLAN.filter((planned) => step >= planned.announce).map((planned): WorkflowAgent => {
    if (step < planned.start) return agent(planned.index, planned.label, "queued", { phaseIndex: planned.phase })
    if (step < planned.end) {
      return agent(planned.index, planned.label, "running", {
        phaseIndex: planned.phase, startedAt: at(planned.start), tokens: (step - planned.start + 1) * 900, toolCalls: step - planned.start,
      })
    }
    return agent(planned.index, planned.label, planned.failed ? "failed" : "done", {
      phaseIndex: planned.phase, startedAt: at(planned.start), lastProgressAt: at(planned.end),
      tokens: (planned.end - planned.start) * 900, toolCalls: planned.end - planned.start,
      ...(planned.failed ? { error: "Draft came back empty." } : {}),
    })
  })
  const done = step >= LIVE_DONE_AT
  return {
    id: "wf-live",
    type: "workflow",
    label: "poem-tournament",
    status: done ? "completed" : "running",
    startedAt: runStart,
    ...(done ? { endedAt: at(LIVE_DONE_AT) } : {}),
    stoppable: true,
    workflow: {
      name: "poem-tournament",
      phases: [{ index: 1, title: "Draft" }, { index: 2, title: "Score" }, { index: 3, title: "Synthesize" }],
      agents,
    },
  }
}
