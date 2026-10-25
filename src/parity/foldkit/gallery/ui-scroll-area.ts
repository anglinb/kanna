// src/foldkit/ui/scroll-area.ts against the React <ScrollArea> (gallery/ui-scroll-area.tsx).
import { scrollArea } from "../../../foldkit/ui/scroll-area"
import { SCROLL_ROWS } from "../../react/gallery/support/scroll-rows"
import { staticPage } from "./support/static-page"

export default staticPage((h) =>
  h.div([h.Class("flex gap-4 bg-background p-4 text-foreground")], [
    scrollArea(
      { class: "h-40 w-60 rounded-lg border border-border", attributes: [h.AriaLabel("Rows")] },
      SCROLL_ROWS.map((row) => h.keyed("div")(row, [h.Class("border-b border-border px-3 py-2 text-sm")], [row])),
      h,
    ),
  ]),
)
