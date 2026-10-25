import type { Html, HtmlBuilder } from "foldkit/html"
import type { ChartToolPayload } from "../../../shared/display-tools"
import type { RowContext } from "./context"
import type { Message } from "./model"

export function chartTool(_key: string, payload: ChartToolPayload, _context: RowContext, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("chart-card")], [payload.title])
}
