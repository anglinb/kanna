import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
import { Message } from "./model"

/**
 * Tool payloads a row needs as soon as it is drawn: an expanded call's
 * body, a display tool's result, a chat or schedule card's input. React
 * asked from `useToolPayload` as the component mounted; this is that, on the
 * element. The request itself is the transcript's (an OutMessage), batched
 * per tick in update.
 */
export const RequestPayloadsOnMount = Mount.define("RequestPayloadsOnMount", {
  args: { entryIds: Schema.Array(Schema.String) },
  messages: [Message.WantedPayloads],
  execute: ({ element: _element, entryIds }) => Effect.succeed(Message.WantedPayloads({ entryIds })),
})
