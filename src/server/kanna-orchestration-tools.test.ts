import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { z } from "zod"
import { ServerPlatform } from "./effect/runtime"
import { ORCHESTRATION_TOOLS } from "./kanna-orchestration-tools"
import { KannaToolRuntime } from "./kanna-tools"
import { getTranscriptMediaDir } from "./transcript-media"

test("reply_to_ticket finishes a reply it started when the call is cancelled, keeping its files", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-ticket-attachments-"))
  const source = path.join(dataDir, "report.txt")
  const mediaDir = getTranscriptMediaDir(dataDir, "chat-1")
  await writeFile(source, "Draft")
  const enteredReply = Effect.runSync(Deferred.make<void>())
  const release = Effect.runSync(Deferred.make<void>())
  let replied = false
  const replyToTicket = ORCHESTRATION_TOOLS.find((tool) => tool.name === "reply_to_ticket")!
  const orchestrator = {
    checkTicket: () => Effect.void,
    replyToTicket: () => Deferred.succeed(enteredReply, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(Effect.sync(() => { replied = true; return { replyId: "reply-1" } })),
    ),
  }
  const context = {
    chatId: "chat-1",
    cwd: dataDir,
    dataDir,
    orchestration: orchestrator as never,
    requestInput: () => Effect.succeed(""),
  }

  try {
    const fiber = Effect.runFork(replyToTicket.execute({
      ticketId: "ticket-1",
      text: "Draft",
      attachments: [{ path: source }],
    }, context).pipe(Effect.provide(ServerPlatform)))
    await Effect.runPromise(Deferred.await(enteredReply))
    expect(await readdir(mediaDir)).toHaveLength(1)

    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await Effect.runPromise(Deferred.succeed(release, undefined))
    await interrupted
    expect(replied).toBe(true)
    expect(await readdir(mediaDir)).toHaveLength(1)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("orchestration tools expose the original strict object schemas", () => {
  const tools = Object.fromEntries(ORCHESTRATION_TOOLS.map((tool) => [tool.name, tool]))
  const reference = {
    get_context: z.strictObject({}),
    list_chats: z.strictObject({
      projectId: z.string().optional().describe("Only chats in this project."),
      query: z.string().optional().describe("Text to find in titles and each chat's latest messages."),
      status: z.enum(["idle", "running", "needs_input", "waiting_on_subagent", "waiting_on_subchats", "completed", "failed", "cancelled"]).optional().describe("waiting_on_subagent and waiting_on_subchats are a chat whose own turn ended while work it handed off is still going: its provider's own subagents, or chats it started. A shell or a monitor left running in the background is not a wait."),
      parentChatId: z.string().optional().describe("Only sub-chats of this chat."),
      includeArchived: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
      offset: z.number().int().min(0).optional(),
    }),
    reply_to_ticket: z.strictObject({
      ticketId: z.string(),
      text: z.string().describe("Markdown."),
      asksUser: z.boolean().optional().describe("true only for a question that blocks the work or its Done; the ticket waits on the user until they reply. false withdraws an open question."),
      attachments: z.array(z.strictObject({
        path: z.string().min(1).optional().describe("Local file path, absolute or relative to the project directory."),
        url: z.string().url().optional().describe("HTTP or HTTPS URL. Provide path or url, not both."),
        kind: z.enum(["image", "video", "file"]).optional().describe("For web URLs without a file extension, specify the media kind. Local files use their detected type."),
      })).max(24).optional().describe("Files to show with the reply: local paths or HTTP/HTTPS URLs, as send_attachments takes them."),
    }),
  }
  for (const [name, schema] of Object.entries(reference)) {
    expect(JSON.parse(JSON.stringify(tools[name]!.inputSchema))).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(schema))))
  }
})

test("native orchestration tools preserve invalid argument text and transcript content", async () => {
  const events: Array<{ kind: string; content?: unknown }> = []
  const runtime = new KannaToolRuntime({
    chatId: "chat-1", cwd: "/project", emit: async (entry) => { events.push(entry) },
    requestInput: async () => ({}),
    orchestration: { getContext: () => Effect.succeed({ chatId: "chat-1" }) } as never,
  }, ORCHESTRATION_TOOLS)
  const invalid = await runtime.execute("get_context", { unexpected: true })
  expect(invalid.isError).toBe(true)
  expect(invalid.content[0]!.text).toBe(z.strictObject({}).safeParse({ unexpected: true }).error!.message)
  const result = await runtime.execute("get_context", {})
  expect(result).toEqual({ content: [{ type: "text", text: '{"chatId":"chat-1"}' }] })
  expect(events.at(-1)?.content).toEqual({ chatId: "chat-1" })
  const unavailable = new KannaToolRuntime({
    chatId: "chat-1", cwd: "/project", emit: async () => {}, requestInput: async () => ({}),
  }, ORCHESTRATION_TOOLS)
  expect(await unavailable.execute("get_context", {})).toEqual({
    content: [{ type: "text", text: "The chat tools are not available in this session." }], isError: true,
  })
})
