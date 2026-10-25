// src/client/components/ui/popover.tsx as the app uses it: an end-aligned
// filter list, a controlled start-aligned list that closes on choice, and a
// default one with a field (gallery/ui-popover.ts on the Foldkit side).
import { useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "../../../client/components/ui/popover"
import { POPOVER_FILTERS, POPOVER_MODELS } from "./support/popover-options"

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"
const optionClass = "flex w-full items-center px-3 py-2 text-left text-sm hover:bg-muted"

export default function PopoverGallery() {
  const [filter, setFilter] = useState("Everything")
  const [model, setModel] = useState("Opus")
  const [open, setOpen] = useState(false)
  return (
    <div className="flex min-h-dvh items-start justify-between bg-background p-8 text-foreground">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className={triggerClass}>{model}</button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 overflow-hidden p-0">
          <div className="max-h-80 overflow-y-auto divide-y divide-border/60">
            {POPOVER_MODELS.map((option) => (
              <button key={option} type="button" className={optionClass} onClick={() => { setModel(option); setOpen(false) }}>{option}</button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button className={triggerClass}>Details</button>
        </PopoverTrigger>
        <PopoverContent>
          <p className="mb-2 text-sm">Name this chat</p>
          <input aria-label="Chat name" className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm" defaultValue="Port the UI" />
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button aria-label="Filter projects" className={triggerClass}>{filter}</button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-60 overflow-hidden p-0">
          <div className="max-h-96 overflow-y-auto divide-y divide-border/60">
            {POPOVER_FILTERS.map((option) => (
              <button key={option} type="button" className={optionClass} onClick={() => setFilter(option)}>{option}</button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
