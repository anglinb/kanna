// src/client/components/ui/dialog.tsx as the app uses it: controlled open,
// header / body / footer, the primary and ghost buttons, three sizes
// (gallery/ui-dialog.ts on the Foldkit side).
import { useState } from "react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogGhostButton,
  DialogHeader,
  DialogPrimaryButton,
  DialogTitle,
} from "../../../client/components/ui/dialog"

const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

export default function DialogGallery() {
  const [open, setOpen] = useState<"sm" | "md" | "lg" | null>(null)
  const [saved, setSaved] = useState(0)
  return (
    <div className="flex min-h-dvh flex-col items-start gap-3 bg-background p-6 text-foreground">
      <button type="button" className={triggerClass} onClick={() => setOpen("md")}>Pair device</button>
      <button type="button" className={triggerClass} onClick={() => setOpen("sm")}>Small</button>
      <button type="button" className={triggerClass} onClick={() => setOpen("lg")}>Large</button>
      <p className="text-sm">Saved {saved} times</p>
      <Dialog open={open === "md"} onOpenChange={(next) => setOpen(next ? "md" : null)}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>Pair a device</DialogTitle>
            <DialogDescription>Scan the code with the Kanna app.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <input aria-label="Device name" className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm" defaultValue="iPhone" />
          </DialogBody>
          <DialogFooter>
            <DialogGhostButton onClick={() => setOpen(null)}>Cancel</DialogGhostButton>
            <DialogPrimaryButton onClick={() => { setSaved((count) => count + 1); setOpen(null) }}>Pair</DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open === "sm"} onOpenChange={(next) => setOpen(next ? "sm" : null)}>
        <DialogContent size="sm" className="gap-0">
          <DialogBody className="space-y-4">
            <DialogTitle>Archive this chat?</DialogTitle>
            <DialogDescription>It moves to the archive; nothing is deleted.</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <DialogGhostButton onClick={() => setOpen(null)}>Cancel</DialogGhostButton>
            <DialogPrimaryButton disabled>Archive</DialogPrimaryButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={open === "lg"} onOpenChange={(next) => setOpen(next ? "lg" : null)}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Release notes</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {Array.from({ length: 30 }, (_, index) => (
              <p key={index} className="py-1 text-sm">Change {index + 1}: something got better.</p>
            ))}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  )
}
