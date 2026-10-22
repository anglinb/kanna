import type { ProcessedTextMessage } from "./types"
import { TranscriptMarkdown } from "./shared"

interface Props {
  message: ProcessedTextMessage
}

/**
 * An agent's words, as the transcript draws them: full-width markdown, no
 * avatar and no name.
 */
export function AssistantText({ text }: { text: string }) {
  return (
    // <VerticalLineContainer className="w-full">
      <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
        <TranscriptMarkdown text={text} />
      </div>
    // </VerticalLineContainer>
  )
}

export function TextMessage({ message }: Props) {
  return <AssistantText text={message.text} />
}
