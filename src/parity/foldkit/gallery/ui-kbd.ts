// src/foldkit/ui/kbd.ts against the React <Kbd> (gallery/ui-kbd.tsx).
import { kbd, kbdGroup } from "../../../foldkit/ui/kbd"
import { staticPage } from "./support/static-page"

export default staticPage((h) =>
  h.div([h.Class("flex flex-col items-start gap-3 bg-background p-4 text-foreground")], [
    kbd({}, ["⌘"], h),
    kbdGroup({}, [kbd({}, ["CMD"], h), kbd({}, ["SHIFT"], h), kbd({}, ["K"], h)], h),
    kbd({ class: "text-muted-foreground" }, ["ESC"], h),
  ]),
)
