// src/foldkit/ui/button.ts against the React <Button> (gallery/ui-button.tsx).
import { button } from "../../../foldkit/ui/button"
import { BUTTON_SIZES, BUTTON_VARIANTS } from "../../gallery-support/button-states"
import { staticPage } from "./support/static-page"

export default staticPage((h) =>
  h.div([h.Class("flex flex-col gap-3 bg-background p-4 text-foreground")], [
    ...BUTTON_VARIANTS.map((variant) =>
      h.div([h.Class("flex flex-wrap items-center gap-2")], [
        ...BUTTON_SIZES.map((size) => button({ variant, size }, [`${variant} ${size}`], h)),
        button({ variant, disabled: true }, [`${variant} disabled`], h),
      ]),
    ),
    h.div([h.Class("flex items-center gap-2")], [
      button({ type: "button", class: "w-40" }, ["Typed with class"], h),
      button({ variant: "ghost", size: "icon", attributes: [h.AriaLabel("Icon only")] }, ["I"], h),
    ]),
  ]),
)
