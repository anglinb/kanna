// src/client/components/ui/skeleton.tsx (gallery/ui-skeleton.ts on the Foldkit side).
import { Skeleton } from "../../../client/components/ui/skeleton"

export default function SkeletonGallery() {
  return (
    <div className="flex flex-col gap-3 bg-background p-4 text-foreground">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-10 w-10 rounded-full" />
      <Skeleton className="h-3" style={{ width: "60%" }} />
    </div>
  )
}
