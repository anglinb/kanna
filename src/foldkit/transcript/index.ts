import { Submodel, Subscription } from "foldkit"
import type { SliceViewInputs } from "../app/slice"
import type { ChatPageSliceInputs } from "../chat/pageInputs"
import type { KannaSocketService } from "../core/socket"
import { Message } from "./message"
import { init, Model } from "./model"
import { pageSource } from "./source"
import { transcriptView } from "./view"

// The chat transcript: the viewport (ChatTranscriptViewport and the
// message-scroller it sits in), the minimap (TranscriptMinimap) and the rows
// (messages/, KannaTranscript's components). Embedded by chat/.
//
//   model.ts / message.ts   the Model and Messages
//   update.ts               what they do (`step` is shared with the export viewer)
//   view.ts                 the viewport's DOM; source.ts what it draws from
//   resolve.ts              KannaTranscript's row resolver (which messages draw which rows)
//   viewport.ts             the scroll position's bookkeeping, against the live DOM
//   scroller.ts             the message-scroller primitive (follow the end, keep the place)
//   minimap.ts              the turn strip and its card
//   export/                 the standalone export viewer (src/export-viewer)
//   messages/               the rows

export { Message, Model, init }
export { update } from "./update"

type ViewInputs = SliceViewInputs & Partial<Pick<ChatPageSliceInputs, "page" | "emptyState">>

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) =>
  transcriptView(model, pageSource(inputs.app, inputs.page, model), inputs.emptyState ? { emptyState: inputs.emptyState } : {}, h))

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({}))
