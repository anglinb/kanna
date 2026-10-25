// src/client/components/chat-ui/StandaloneShareDialog.tsx as App.tsx renders
// it: open while there is a link, with useShareExport's copy and open
// (gallery/chat-share-dialog.ts on the Foldkit side).
import { useState } from "react"
import { StandaloneShareDialog } from "../../../client/components/chat-ui/StandaloneShareDialog"

const SHARE_URL = "https://kanna.sh/s/3f9c2a7e-demo-chat-units"
const triggerClass = "rounded-md border border-border px-3 py-1.5 text-sm"

export default function ChatShareDialogGallery() {
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [opened, setOpened] = useState(0)
  const [copyError, setCopyError] = useState<string | null>(null)
  return (
    <div className="flex min-h-dvh flex-col items-start gap-3 bg-background p-6 text-foreground">
      <button type="button" className={triggerClass} onClick={() => setShareUrl(SHARE_URL)}>Share</button>
      <p className="text-sm">Opened {opened} times</p>
      {copyError ? <p className="text-sm">Copy failed: {copyError}</p> : null}
      <StandaloneShareDialog
        open={Boolean(shareUrl)}
        shareUrl={shareUrl ?? ""}
        onOpenChange={(open) => {
          if (!open) setShareUrl(null)
        }}
        onOpenLink={() => {
          setOpened((count) => count + 1)
          setShareUrl(null)
        }}
        onCopyLink={async () => {
          try {
            if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("Clipboard is not available")
            await navigator.clipboard.writeText(SHARE_URL)
            return true
          } catch (error) {
            setCopyError(error instanceof Error ? error.message : String(error))
            return false
          }
        }}
      />
    </div>
  )
}
