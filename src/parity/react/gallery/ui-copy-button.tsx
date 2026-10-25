// src/client/components/ui/copy-button.tsx (gallery/ui-copy-button.ts on the Foldkit side).
import { CopyButton } from "../../../client/components/ui/copy-button"

export default function CopyButtonGallery() {
  return (
    <div className="flex items-center gap-4 bg-background p-4 text-foreground">
      <CopyButton text="npm install kanna" title="Copy command" className="h-8 w-8 text-muted-foreground" />
      <CopyButton text="ABCD-1234" title="Copy code" copiedTitle="Copied" className="h-7 w-7" checkClassName="h-3.5 w-3.5 text-green-400" />
      <CopyButton text="kanna dev" title="Copy quietly" copiedHoverReset={false} className="h-8 w-8 text-muted-foreground hover:text-foreground hover:!border-border/0 hover:!bg-transparent" />
      <CopyButton
        plain
        onCopy={() => true}
        title="Copy link"
        copiedTitle="Copied link"
        checkClassName="h-4 w-4 text-emerald-400"
        className="flex flex-shrink-0 items-center justify-center rounded-lg text-logo hover:text-logo/60 transition-colors hover:bg-background hover:text-foreground"
      />
    </div>
  )
}
