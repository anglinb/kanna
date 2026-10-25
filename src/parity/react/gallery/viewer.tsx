// The viewer layer on its own (components/viewer/ViewerLayer.tsx), as a page
// without a chat shows it (the export viewer's `className="fixed"`), opened
// on the item `?item=` names (support/viewer-items.ts): attachments of each
// kind, a chart and a visualization at full size. Matched by
// gallery/viewer.ts on the Foldkit side.
import { useState } from "react"
import { TooltipProvider } from "../../../client/components/ui/tooltip"
import { ViewerLayer } from "../../../client/components/viewer/ViewerLayer"
import { openViewer, useViewerStore } from "../../../client/stores/viewerStore"
import { VIEWER_GALLERY_CHAT_ID, viewerGalleryItem } from "./support/viewer-items"

function openGalleryItem() {
  useViewerStore.getState().setChat(VIEWER_GALLERY_CHAT_ID)
  openViewer(viewerGalleryItem(window.location.search))
  return true
}

export default function ViewerGallery() {
  useState(openGalleryItem)
  return (
    <TooltipProvider>
      <div className="relative h-full bg-background">
        <ViewerLayer className="fixed" />
      </div>
    </TooltipProvider>
  )
}
