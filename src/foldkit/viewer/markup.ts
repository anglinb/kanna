import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message"
import type { Model } from "./model"

// VisualizationMarkup (messages/VisualizationMarkup.tsx): draw on a capture
// of a visualization, then hand it to the composer as a PNG.

export function markupView(_model: Model, _title: string, _h: HtmlBuilder<Message>): Html | null {
  return null
}
