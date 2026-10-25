// src/foldkit/ui/card.ts against the React card (gallery/ui-card.tsx).
import { card, cardContent, cardDescription, cardFooter, cardHeader, cardTitle } from "../../../foldkit/ui/card"
import { staticPage } from "./support/static-page"

export default staticPage((h) =>
  h.div([h.Class("flex flex-col gap-4 bg-background p-4 text-foreground")], [
    card({ class: "w-80 rounded-xl border border-border" }, [
      cardHeader({}, [
        cardTitle({}, ["Usage"], h),
        cardDescription({}, ["Five hours of Claude, resetting in 2h."], h),
      ], h),
      cardContent({}, ["Content goes here."], h),
      cardFooter({ class: "justify-end" }, ["Footer"], h),
    ], h),
    card({}, ["Bare card"], h),
  ]),
)
