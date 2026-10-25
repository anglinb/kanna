// src/foldkit/ui/animated-shiny-text.ts against the React <AnimatedShinyText>
// (gallery/ui-animated-shiny-text.tsx). Animations are frozen for captures.
import { animatedShinyText } from "../../../foldkit/ui/animated-shiny-text"
import { staticPage } from "./support/static-page"

export default staticPage((h) =>
  h.div([h.Class("flex w-80 flex-col items-start gap-3 bg-background p-4 text-foreground")], [
    animatedShinyText({ class: "!mx-0 text-sm", shimmerWidth: 44 }, ["Thinking…"], h),
    animatedShinyText({ animate: false }, ["Read 3 files"], h),
    animatedShinyText(
      { class: "!mx-0 min-w-0 shrink truncate", shimmerWidth: 60 },
      () => [h.span([], ["A label long enough to truncate at the edge of its column"])],
      h,
    ),
  ]),
)
