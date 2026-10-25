// src/client/components/ui/segmented-control.tsx (gallery/ui-segmented-control.ts on the Foldkit side).
import { useState } from "react"
import { Folder, Pencil, Square } from "lucide-react"
import { SegmentedControl } from "../../../client/components/ui/segmented-control"

type Tool = "pan" | "pen" | "box"
type Format = "png" | "svg" | "html"

const TOOLS = [
  { value: "pan" as const, label: "Pan", icon: Folder },
  { value: "pen" as const, label: "Pen", icon: Pencil },
  { value: "box" as const, label: "Box", icon: Square },
]

const FORMATS = [
  { value: "png" as const, label: "PNG" },
  { value: "svg" as const, label: "SVG" },
  { value: "html" as const, label: "HTML", disabled: true },
]

export default function SegmentedControlGallery() {
  const [tool, setTool] = useState<Tool>("pen")
  const [format, setFormat] = useState<Format>("png")
  return (
    <div className="flex flex-col items-start gap-4 bg-background p-4 text-foreground">
      <SegmentedControl size="sm" value={tool} onValueChange={setTool} options={TOOLS} />
      <SegmentedControl value={format} onValueChange={setFormat} options={FORMATS} />
      <SegmentedControl value={format} onValueChange={setFormat} options={FORMATS} className="w-80" optionClassName="flex-1 justify-center" />
    </div>
  )
}
