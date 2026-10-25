import type { AppModel } from "../app/slice"
import { block, type CmdkBlock } from "./cmdk"
import type { Message } from "./message"

// The Usage… page: `<div className="px-2 py-1.5"><UsageSection state={state} /></div>`.

export function usageBlock(_app: AppModel): CmdkBlock<Message> {
  return block("usage", (h) => h.div([h.Class("px-2 py-1.5")], []))
}
