import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
import { domStream } from "../../ui/overlay/stream"
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

/** A node React would own: anything in the page but the document's own html and body. */
function isAppNode(node: EventTarget | null): node is Node {
  return node instanceof Node && node.isConnected && node !== document.documentElement && node !== document.body
}

/**
 * React's `onPointerEnter`, which warms a tool row's payloads on hover.
 *
 * React does not listen for the native pointerenter: it derives enters from
 * the pointerout/pointerover pair at its root. An out names where the pointer
 * went (`relatedTarget`) and enters everything around it that did not hold
 * where it came from. An over whose `relatedTarget` is a node React manages
 * is left to that out, and only an over from outside the page enters on its
 * own. So when the element under a resting pointer goes away (Load More,
 * replaced by the rows it loaded) and the browser sends no out for it, the
 * row that slides under the pointer is not entered, and nothing is fetched.
 * A native pointerenter (or mouseenter) would fetch it.
 */
export const RequestPayloadsOnPointerEnter = Mount.defineStream("RequestPayloadsOnPointerEnter", {
  args: { entryIds: Schema.Array(Schema.String) },
  messages: [Message.WantedPayloads],
  execute: ({ element, entryIds }) =>
    domStream<typeof Message.WantedPayloads.Type>((emit) => {
      const inside = (node: EventTarget | null) => node instanceof Node && element.contains(node)
      const onOut = (event: Event) => {
        const { target, relatedTarget } = event as PointerEvent
        if (isAppNode(relatedTarget) && inside(relatedTarget) && !inside(target)) emit(Message.WantedPayloads({ entryIds }))
      }
      const onOver = (event: Event) => {
        const { target, relatedTarget } = event as PointerEvent
        if (isAppNode(relatedTarget)) return
        if (inside(target)) emit(Message.WantedPayloads({ entryIds }))
      }
      document.addEventListener("pointerout", onOut, true)
      document.addEventListener("pointerover", onOver, true)
      return () => {
        document.removeEventListener("pointerout", onOut, true)
        document.removeEventListener("pointerover", onOver, true)
      }
    }),
})
