// src/foldkit/ui/skeleton.ts against the React <Skeleton> (gallery/ui-skeleton.tsx).
import { skeleton } from "../../../foldkit/ui/skeleton"
import { staticPage } from "./support/static-page"

export default staticPage((h) =>
  h.div([h.Class("flex flex-col gap-3 bg-background p-4 text-foreground")], [
    skeleton({ class: "h-4 w-48" }, h),
    skeleton({ class: "h-4 w-32" }, h),
    skeleton({ class: "h-10 w-10 rounded-full" }, h),
    skeleton({ class: "h-3", style: { width: "60%" } }, h),
  ]),
)
