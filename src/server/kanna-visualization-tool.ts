import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { Effect, FileSystem, type PlatformError, Schema } from "effect"
import { VISUALIZATION_MAX_BYTES, VISUALIZATION_MAX_HEIGHT, VISUALIZATION_TOOL_NAME, type VisualizationArtifact } from "../shared/visualization"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import { buildVisualizationDocument } from "./visualization-document"
import { SHOW_VISUALIZATION_DESCRIPTION } from "./visualization-instructions"
import { defineKannaTool, failureText, KannaToolCallError, KannaToolRefusal, platformFailureText } from "./kanna-tool-definition"

const parameters = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({ description: "Accessible name for the visualization. No title bar is added." }),
  html: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(VISUALIZATION_MAX_BYTES)).annotate({ description: "Self-contained HTML fragment, including inline CSS and JavaScript. Supply html or path, not both." })),
  path: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1)).annotate({ description: "HTML file, absolute or relative to the project. Copied into this chat; source edits will not change the saved visualization." })),
  height: Schema.optionalKey(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(80), Schema.isLessThanOrEqualTo(VISUALIZATION_MAX_HEIGHT)).annotate({ description: "Initial height in CSS pixels, default 360. The frame then fits the content automatically." })),
  ticketId: Schema.optionalKey(Schema.String.annotate({ description: "Delegator chats only: also post it on this ticket, as a reply. Other chats cannot post on tickets." })),
  text: Schema.optionalKey(Schema.String.annotate({ description: "With ticketId: the reply's words (markdown), posted with the visualization as one reply, as reply_to_ticket's text." })),
  asksUser: Schema.optionalKey(Schema.Boolean.annotate({ description: "With ticketId: as on reply_to_ticket, true only when the reply's question blocks the work or its Done." })),
})

/**
 * The first thing in a document that the frame's CSP will refuse to load. A
 * page built on a CDN chart library renders as an empty box, and the model
 * that wrote it is told it succeeded; refused here, the error says what to do
 * while the model can still do it.
 */
export function externalResource(html: string): string | null {
  const script = /<script\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(html)
  if (script) return `a script from ${script[1]}`
  const sheet = /<link\b[^>]*\shref\s*=\s*["']?(https?:[^"'\s>]+)/i.exec(html) ?? /@import\s+(?:url\()?["']?(https?:[^"')\s;]+)/i.exec(html)
  if (sheet) return `a stylesheet from ${sheet[1]}`
  const image = /<img\b[^>]*\ssrc\s*=\s*["']?(https?:[^"'\s>]+)/i.exec(html)
  return image ? `an image from ${image[1]}` : null
}

const refuse = (message: string) => new KannaToolRefusal({ tool: VISUALIZATION_TOOL_NAME, message })
const callError = (operation: string) => (cause: unknown) =>
  new KannaToolCallError({ tool: VISUALIZATION_TOOL_NAME, operation, message: failureText(cause), cause })
const platformError = (operation: string) => (cause: PlatformError.PlatformError) =>
  Effect.fail(new KannaToolCallError({ tool: VISUALIZATION_TOOL_NAME, operation, message: platformFailureText(cause), cause }))

/**
 * The HTML in a file the agent named. Node's `open` with `O_NONBLOCK`, as
 * `storeLocalAttachment` does: a FIFO is refused instead of blocking the
 * call, and the size checked is the opened file's.
 */
const readHtmlFile = Effect.fn("KannaVisualizationTool.readHtmlFile")(function* (filePath: string) {
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(filePath, constants.O_RDONLY | constants.O_NONBLOCK), catch: callError("open") }),
    (file) => Effect.gen(function* () {
      const info = yield* Effect.tryPromise({ try: () => file.stat(), catch: callError("stat") })
      if (!info.isFile()) return yield* refuse("The visualization path must be a file.")
      if (info.size > VISUALIZATION_MAX_BYTES) return yield* refuse("Visualizations must be 2 MB or smaller.")
      return yield* Effect.tryPromise({ try: () => file.readFile("utf8"), catch: callError("read") })
    }),
    (file) => Effect.tryPromise(() => file.close()).pipe(Effect.ignore),
  )
})

export const SHOW_VISUALIZATION_TOOL = defineKannaTool({
  name: VISUALIZATION_TOOL_NAME,
  description: SHOW_VISUALIZATION_DESCRIPTION,
  parameters,
  execute: Effect.fn("KannaVisualizationTool.execute")(function* (args, context) {
    yield* Effect.annotateCurrentSpan("chatId", context.chatId)
    if (Boolean(args.html) === Boolean(args.path)) return yield* refuse("Provide exactly one of html or path.")
    if (!context.dataDir) return yield* refuse("Chat media storage is unavailable.")
    if (!args.ticketId && (args.text !== undefined || args.asksUser !== undefined)) {
      return yield* refuse("text and asksUser go with ticketId: they are the ticket reply's. Without a ticket, say it in your message.")
    }
    const orchestration = context.orchestration
    // Before anything is written, so a wrong ticket leaves no file behind.
    if (args.ticketId) {
      if (!orchestration) return yield* refuse("Tickets are not available in this session.")
      const ticketId = args.ticketId
      yield* orchestration.checkTicket(context.chatId, ticketId)
    }
    const html = args.path ? yield* readHtmlFile(path.resolve(context.cwd, args.path)) : args.html
    if (!html?.trim()) return yield* refuse("The visualization HTML is empty.")
    if (Buffer.byteLength(html) > VISUALIZATION_MAX_BYTES) return yield* refuse("Visualizations must be 2 MB or smaller.")
    const external = externalResource(html)
    if (external) return yield* refuse(`The visualization loads ${external}, and nothing external loads in the frame. Inline the script, style, font or image (a data: URI works for images and fonts) and call the tool again.`)
    const height = args.height ?? 360
    const name = `visualization-${crypto.randomUUID()}.html`
    const dir = getTranscriptMediaDir(context.dataDir, context.chatId)
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchTag("PlatformError", platformError("mkdir")))
    const destination = path.join(dir, name)
    yield* fs.writeFileString(destination, buildVisualizationDocument(html, args.title, height), { flag: "wx" }).pipe(
      Effect.catchTag("PlatformError", platformError("write")),
      Effect.onError(() => fs.remove(destination, { force: true }).pipe(Effect.ignore)),
    )
    const artifact: VisualizationArtifact = { type: "visualization", version: 1, title: args.title, height, url: buildTranscriptMediaUrl(context.chatId, name) }
    // The ticket's reply points at the same file. The HTML is never copied
    // into the board. Its words go in the same reply: a mock posted alone and
    // then explained in a second reply read as two messages.
    const ticketId = args.ticketId
    const posted = ticketId && orchestration
      ? yield* Effect.uninterruptible(orchestration.replyToTicket(context.chatId, { ticketId, text: args.text ?? "", asksUser: args.asksUser, artifacts: [artifact] }))
      : null
    return {
      content: [{ type: "text" as const, text: `Visualization displayed inline in Kanna${ticketId ? ` and posted on ticket ${ticketId}` : ""}. Do not repeat it as an image, file attachment, or visualization marker.${posted?.note ? ` ${posted.note}` : ""}` }],
      structuredContent: { displayed: true, visualization: artifact },
      transcriptContent: [artifact],
    }
  }),
})
