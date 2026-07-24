import { useOutletContext } from "react-router-dom"
import { DEFAULT_NEW_PROJECTS_DIRECTORY } from "../../shared/types"
import { SetupCard } from "../components/auth/SetupCard"
import { GitHubReposSection } from "../components/GitHubReposSection"
import { LocalDev } from "../components/LocalDev"
import type { KannaState } from "./useKannaState"

export function LocalProjectsPage() {
  const state = useOutletContext<KannaState>()

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <LocalDev
        connectionStatus={state.connectionStatus}
        ready={state.localProjectsReady}
        snapshot={state.localProjects}
        startingLocalPath={state.startingLocalPath}
        commandError={state.commandError}
        onOpenProject={state.handleOpenLocalProject}
        providerCards={<SetupCard className="mb-8" />}
        githubSection={
          <GitHubReposSection
            socket={state.socket}
            newProjectsDirectory={state.appSettings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY}
            onCloneRepo={state.handleCreateProject}
          />
        }
      />
    </div>
  )
}
