import { defineScenario, type Scenario } from "../scenario"

// The command palette (src/client/components/command-palette) over the home
// page: opened with the keyboard shortcut, the quick switcher at rest
// (Review, In Progress, Recents, Actions), arrow keys moving the highlight,
// and Escape closing it. The region is the palette's dialog alone, so the
// page behind it doesn't decide the run.

const PALETTE = "[role=dialog]:has([cmdk-root])"

export const scenarios: Scenario[] = [
  defineScenario({
    name: "palette-root-keys",
    // The running chat's spinner rasterizes a few pixels differently run to
    // run, React against React (28 px at a highlight move).
    pixelTolerance: 0.0003,
    route: "/home",
    regions: { palette: PALETTE },
    covers: { keybindings: ["openCommandPalette"] },
    async run({ page, capture }) {
      await page.keyboard.press("Control+k")
      await capture("open")
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("ArrowDown")
      await page.keyboard.press("ArrowDown")
      await capture("arrow-down")
      await page.keyboard.press("ArrowUp")
      await capture("arrow-up")
      await page.keyboard.press("End")
      await capture("end")
      await page.keyboard.press("Home")
      await capture("home")
      await page.keyboard.press("Escape")
      await capture("escape")
      await page.keyboard.press("Control+k")
      await capture("reopen")
      await page.keyboard.press("Control+k")
      await capture("toggle-closed")
    },
  }),
]
