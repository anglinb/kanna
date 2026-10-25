// src/client/components/ui/project-icon.tsx (gallery/ui-project-icon.ts on the Foldkit side).
import { ProjectIcon } from "../../../client/components/ui/project-icon"
import { PROJECT_NAMES } from "./support/project-names"

export default function ProjectIconGallery() {
  return (
    <div className="flex flex-col gap-3 bg-background p-4 text-foreground">
      {PROJECT_NAMES.map((name) => (
        <div key={name} className="flex items-center gap-2 text-sm">
          <ProjectIcon name={name} />
          <span>{name}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-sm">
        <ProjectIcon name="kanna" iconUrl="/favicon.png" />
        <span>With an icon</span>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <ProjectIcon name="broken-icon" iconUrl="/no-such-icon.png" className="opacity-50" />
        <span>Icon that fails to load</span>
      </div>
    </div>
  )
}
