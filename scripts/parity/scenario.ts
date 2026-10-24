import type { Page } from "playwright"

export type Theme = "dark" | "light"
export type ViewportName = "desktop" | "mobile"

export const VIEWPORTS: Record<ViewportName, { width: number; height: number; mobile: boolean }> = {
  desktop: { width: 1440, height: 900, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
}

export interface ScenarioContext {
  page: Page
  viewport: ViewportName
  theme: Theme
  /** Plays the backend's scripted turns forward by `ms`, then settles. */
  advance(ms: number): Promise<void>
  /** Waits until the socket and the DOM have been quiet. */
  settle(): Promise<void>
  /** Records a capture under `label`. Without any call, "final" is taken at the end. */
  capture(label: string): Promise<void>
}

/**
 * One screen or interaction, run the same way against both apps. Drive it
 * through accessible locators (roles, labels, text): both apps must expose
 * the same ones, so anything a scenario can't find is itself a parity gap.
 *
 * Scenarios are part of the harness: a port agent never edits one to make a
 * difference go away. See docs/foldkit-migration.md, "Rules".
 */
export interface Scenario {
  name: string
  /** Path the page opens at, e.g. "/chat/demo-chat-units". */
  route: string
  themes?: Theme[]
  viewports?: ViewportName[]
  /** Fraction of pixels allowed to differ (antialiasing noise). Default 0. */
  pixelTolerance?: number
  /** What the scenario exercises, for the coverage audit. */
  covers?: { commands?: string[]; keybindings?: string[]; routes?: string[] }
  run?(context: ScenarioContext): Promise<void>
}

export function defineScenario(scenario: Scenario) {
  return scenario
}
