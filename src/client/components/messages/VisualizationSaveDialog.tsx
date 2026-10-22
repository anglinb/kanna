import { useRef, useState } from "react"
import { Button } from "../ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../ui/dialog"
import { Input } from "../ui/input"
import { SegmentedControl } from "../ui/segmented-control"
import { canEncodeImageType, encodeVisualizationImage, saveFile } from "../../lib/visualization-image"
import { VISUALIZATION_IMAGE_TYPES, visualizationImageFilename, visualizationImageName, type VisualizationImageType } from "../../../shared/visualization-capture"

/** The type last saved, for the next save in this session. */
let lastImageType: VisualizationImageType = "png"

/**
 * Names and saves a capture. The capture is already drawing when this opens
 * (`image`), so the file is usually ready by the time the name is confirmed.
 * A capture that fails says so here, and the dialog stays open.
 */
export function VisualizationSaveDialog({ title, image, onClose }: {
  title: string
  image: Promise<Blob>
  onClose: () => void
}) {
  const types = (Object.keys(VISUALIZATION_IMAGE_TYPES) as VisualizationImageType[]).filter(canEncodeImageType)
  const [type, setType] = useState<VisualizationImageType>(() => (types.includes(lastImageType) ? lastImageType : "png"))
  const [name, setName] = useState(() => visualizationImageName(title))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const save = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const blob = await encodeVisualizationImage(await image, type)
      saveFile(blob, visualizationImageFilename(name, title, type))
      lastImageType = type
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The image could not be saved.")
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent
        size="sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          input.current?.focus()
          input.current?.select()
        }}
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <DialogBody className="space-y-4">
            <DialogTitle>Download image</DialogTitle>
            <DialogDescription>The visualization at full height, in the current theme.</DialogDescription>
            <div className="flex items-center gap-2">
              <Input
                ref={input}
                type="text"
                aria-label="File name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={visualizationImageName(title)}
                spellCheck={false}
                autoComplete="off"
              />
              <span className="shrink-0 text-sm text-muted-foreground">.{VISUALIZATION_IMAGE_TYPES[type].extension}</span>
            </div>
            {types.length > 1 ? (
              <SegmentedControl
                size="sm"
                value={type}
                onValueChange={setType}
                options={types.map((value) => ({ value, label: VISUALIZATION_IMAGE_TYPES[value].label }))}
              />
            ) : null}
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="secondary" size="sm" disabled={saving}>
              {saving ? "Saving…" : "Download"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
