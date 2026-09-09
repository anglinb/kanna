import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { ProcessedToolCall } from "./types"
import { TextMessage } from "./TextMessage"
import { ToolCallMessage } from "./ToolCallMessage"

interface Props {
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string | null
}

/**
 * What a subagent did, shown inside its Agent row.
 *
 * The same rows the main transcript uses, minus grouping and the special
 * tool views: a subagent's work is read after the fact, so a flat list in
 * order is enough. Anything that is not text or a tool call (a status, a
 * context update) has nothing to show here.
 */
export function SubagentTranscript({ messages, isLoading, localPath }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) => {
        if (message.kind === "assistant_text") {
          return <TextMessage key={message.id} message={message} />
        }
        if (message.kind === "tool") {
          return (
            <ToolCallMessage
              key={message.id}
              message={message as ProcessedToolCall}
              isLoading={isLoading}
              localPath={localPath}
            />
          )
        }
        return null
      })}
    </div>
  )
}
