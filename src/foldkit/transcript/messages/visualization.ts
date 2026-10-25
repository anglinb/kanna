import type { Html, HtmlBuilder } from "foldkit/html"
import type { VisualizationArtifact } from "../../../shared/visualization"
import type { RowContext } from "./context"
import type { Message } from "./model"

export function visualization(_key: string, artifact: VisualizationArtifact, _context: RowContext, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("visualization relative min-w-0")], [artifact.title])
}
