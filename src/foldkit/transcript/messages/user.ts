import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import { stripSystemMessages } from "../../../shared/message-preview"
import type { ChatAttachment } from "../../../shared/types"
import { CornerUpLeft } from "../../ui/icons"
import { userMessageAttachments } from "./attachments"
import { CLAMP_LINES, clampedMessageText, foldSurfaceAttributes } from "./clamped"
import type { RowContext } from "./context"
import { keys, type Message } from "./model"

/**
 * The look of a prompt's bubble. One string because a prompt that was sent to
 * the chat (SourcedMessage) is the same bubble on the other side.
 */
export const USER_BUBBLE_CLASS = "min-w-0 rounded-2xl border border-border bg-muted text-primary prose prose-sm prose-invert"

/**
 * Split a prompt into what is shown and whether anything was held back: a
 * `<system-message>` block is for the agent, not the reader.
 */
function parseSystemMessage(content: string) {
  const body = stripSystemMessages(content)
  return { systemMessage: body === content ? null : true, body }
}

/** What the user typed (UserMessage.tsx). `flash`: a jump just landed here; the bubble lights. */
export function userMessage(
  message: { id: string; content: string; attachments?: ChatAttachment[]; steered?: boolean },
  options: { flash?: boolean },
  context: RowContext,
  h: HtmlBuilder<Message>,
): Html {
  const attachments = message.attachments ?? []
  const parsed = parseSystemMessage(message.content)
  const clampKey = keys.clamp(message.id)
  const showsBubble = parsed.body || (!parsed.body && attachments.length === 0 && message.content && !parsed.systemMessage)
  return h.div([h.Class("flex flex-col items-end gap-2")], [
    ...userMessageAttachments(attachments, "end", context, h),
    showsBubble
      ? h.div([h.Class("flex max-w-[85%] items-center gap-2 sm:max-w-[80%]")], [
        message.steered
          ? h.span([h.AriaLabel("Sent mid-turn"), h.Role("img"), h.Title("Sent mid-turn"), h.Class("shrink-0 text-muted-foreground")], [
            CornerUpLeft({ class: "h-4 w-4" }, h),
          ])
          : null,
        // The flash is a class on the bubble, not a layer inside it.
        h.div([
          ...foldSurfaceAttributes(clampKey, context, h),
          h.Class(cn(USER_BUBBLE_CLASS, "flex-1 px-3.5 py-1.5", options.flash && "kanna-jump-flash")),
        ], clampedMessageText(parsed.body, clampKey, CLAMP_LINES.typed, "surface", context, h)),
      ])
      : null,
  ])
}
