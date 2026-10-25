// The pure half of useTerminalToggleAnimation (src/client/app/
// useTerminalToggleAnimation.ts, a React file, so copied with its rules):
// when opening the terminal asks it for focus, and where its split starts
// and ends a toggle.

export function shouldRequestTerminalFocus(args: {
  previousProjectId: string | null
  projectId: string | null
  showTerminalPane: boolean
  wasTerminalVisible: boolean
}) {
  const didProjectChange = args.previousProjectId !== null && args.previousProjectId !== args.projectId
  const isInitialProjectMount = args.previousProjectId === null && args.projectId !== null

  return !didProjectChange && !isInitialProjectMount && args.showTerminalPane && !args.wasTerminalVisible
}

export function resolveTerminalAnimationState({
  previousProjectId,
  projectId,
  previousShouldRenderTerminalLayout,
  previousShowTerminalPane,
  showTerminalPane,
  mainSizes,
  liveLayout,
}: {
  previousProjectId: string | null
  projectId: string | null
  previousShouldRenderTerminalLayout: boolean
  previousShowTerminalPane: boolean
  showTerminalPane: boolean
  mainSizes: [number, number]
  liveLayout: [number, number]
}): { currentLayout: [number, number]; shouldSkipAnimation: boolean; targetLayout: [number, number] } {
  const didProjectChange = previousProjectId !== null && previousProjectId !== projectId
  const isInitialOpen = showTerminalPane && !previousShowTerminalPane
  const isInitialRender = !previousShouldRenderTerminalLayout
  const isInitialProjectRender = previousProjectId === null && projectId !== null
  const targetLayout: [number, number] = showTerminalPane ? mainSizes : [100, 0]
  const currentLayout: [number, number] = isInitialOpen || isInitialRender ? [100, 0] : liveLayout

  return {
    currentLayout,
    shouldSkipAnimation: didProjectChange || (isInitialProjectRender && isInitialRender),
    targetLayout,
  }
}
