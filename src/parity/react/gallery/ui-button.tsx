// src/client/components/ui/button.tsx: every variant at every size, then
// each variant disabled (gallery/ui-button.ts on the Foldkit side).
import { Button } from "../../../client/components/ui/button"
import { BUTTON_SIZES, BUTTON_VARIANTS } from "./support/button-states"

export default function ButtonGallery() {
  return (
    <div className="flex flex-col gap-3 bg-background p-4 text-foreground">
      {BUTTON_VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-wrap items-center gap-2">
          {BUTTON_SIZES.map((size) => (
            <Button key={size} variant={variant} size={size}>{`${variant} ${size}`}</Button>
          ))}
          <Button variant={variant} disabled>{`${variant} disabled`}</Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button type="button" className="w-40">Typed with class</Button>
        <Button variant="ghost" size="icon" aria-label="Icon only">I</Button>
      </div>
    </div>
  )
}
