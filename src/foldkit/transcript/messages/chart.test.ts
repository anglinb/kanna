import { describe, expect, test } from "bun:test"
import { Submodel } from "foldkit"
import { Scene } from "foldkit/test"
import * as Select from "../../ui/select"
import { ChartArea, chartFullViewBody, chartModel, ChartTable, niceTicks } from "./chart"
import { rowContext } from "./context"
import { CHARTS, displaySections } from "./fixture"
import { view } from "./index"
import { init, Message, update, type Model } from "./model"

// The numbers recharts 3.8 drew for the gallery's charts in a 766×511
// render area (the desktop gallery), read from its DOM.
const BAR_PATH = "M 63.7,212.3938\n            A 4,4,0,0,1,67.7,208.3937\n            L 103.7,208.3937\n            A 4,4,0,0,1,107.7,212.3938\n            L 107.7,477\n            A 4,4,0,0,1,103.7,481\n            L 67.7,481\n            A 4,4,0,0,1,63.7,477 Z"
const SECTOR_PATH = "M 565.625,255.5\n    A 182.625,182.625,0,\n    1,0,\n    243.7589,373.6686\n  L 299.4554,326.4012\n            A 109.575,109.575,0,\n            1,1,\n            492.575,255.5 Z"
const LINE_PATH = "M52,208.394C98.8,121.189,145.6,33.984,192.4,33.984C239.2,33.984,286,76.976,332.8,133.647C379.6,190.318,426.4,374.009,473.2,374.009C520,374.009,566.8,179.57,613.6,174.684C660.4,169.799,707.2,168.578,754,167.356"
const AREA_PATH = "M52,334.888C130,328.425,208,321.961,286,313.242C364,304.524,442,292.197,520,282.577C598,272.956,676,264.238,754,255.519L754,481C676,481,598,481,520,481C442,481,364,481,286,481C208,481,130,481,52,481Z"

describe("recharts' arithmetic", () => {
  test("nice ticks", () => {
    expect(niceTicks(0, 305)).toEqual([0, 80, 160, 240, 320])
    expect(niceTicks(0, 505)).toEqual([0, 150, 300, 450, 600])
    expect(niceTicks(0, 200)).toEqual([0, 50, 100, 150, 200])
    expect(niceTicks(0, 24_700)).toEqual([0, 6500, 13000, 19500, 26000])
    expect(niceTicks(0, 0.7)).toEqual([0, 0.2, 0.4, 0.6, 0.8])
  })

  test("the model: keys, colours, the y axis's width, the CSV", () => {
    const bar = chartModel(CHARTS[0]!)
    expect(bar.keys).toEqual(["desktop", "mobile"])
    expect(bar.yAxisWidth).toBe(40)
    expect(bar.csv.split("\n")[0]).toBe("month,desktop,mobile")
    expect(bar.csvFilename).toBe("visitors_by_month.csv")
    const stacked = chartModel(CHARTS[1]!)
    expect(stacked.legendItems.map((item) => [item.label, item.color])).toEqual([["Desktop", "#00a6f5"], ["Mobile", "#00bd7c"]])
    const area = chartModel(CHARTS[3]!)
    expect(area.hideDecimalValues).toBe(true)
  })
})

function chartRow(index: number) {
  const rows = displaySections("http://localhost").flatMap((section) => section.rows)
  const found = rows.find((row) => row.id === `chart-${index}`)
  if (!found) throw new Error("no chart row")
  return found
}

const sized = (index: number) => Scene.Mount.resolve(ChartArea, Message.MeasuredChart({ key: `chart-${index}`, width: 766, height: 511 }))

describe("the drawn chart", () => {
  for (const [index, path, selector] of [
    [0, BAR_PATH, "path.recharts-rectangle"],
    [2, LINE_PATH, "path.recharts-line-curve"],
    [3, AREA_PATH, "path.recharts-area-area"],
    [4, SECTOR_PATH, "path.recharts-sector"],
  ] as const) {
    test(`${CHARTS[index]!.type}: the first mark's path is recharts' to the character`, () => {
      const target = chartRow(index)
      const area = index === 3
      Scene.scene(
        { update, view: Scene.withViewInputs(view, { item: { kind: "row", row: target } })() },
        Scene.given(init()),
        sized(index),
        Scene.expect(area ? Scene.last(Scene.all.selector(selector)) : Scene.first(Scene.all.selector(selector))).toHaveAttr("d", path),
      )
    })
  }

  test("the full view's table: series down the side, points across, aggregates by row and column", () => {
    const fullView = Submodel.defineView<Model, Message>((model, h) => chartFullViewBody("viewer", CHARTS[0]!, rowContext(model), h))
    Scene.scene(
      { update, view: fullView },
      Scene.given(init()),
      Scene.Mount.resolveAll(
        [ChartArea, Message.MeasuredChart({ key: "viewer", width: 900, height: 460 })],
        [ChartTable, Message.MeasuredChartTable({ key: "viewer", width: 900 })],
        [Select.SelectTrigger, Select.Message.CompletedMountTrigger()],
        [Select.SelectTrigger, Select.Message.CompletedMountTrigger()],
      ),
      Scene.expect(Scene.role("columnheader", { name: "Series" })).toExist(),
      Scene.expect(Scene.role("columnheader", { name: "Jun" })).toExist(),
      // desktop's average over six months, mobile's, then each month's.
      Scene.expect(Scene.role("cell", { name: "204" })).toExist(),
      Scene.expect(Scene.role("cell", { name: "143.33" })).toExist(),
      Scene.expect(Scene.role("cell", { name: "133" })).toExist(),
      Scene.expectAll(Scene.all.role("combobox", { name: "Aggregation" })).toHaveCount(2),
      Scene.click(Scene.role("button", { name: "desktop" })),
      Scene.expect(Scene.role("button", { name: "desktop" })).toHaveAttr("aria-pressed", "false"),
    )
  })

  test("a legend click hides its series and rescales the axis", () => {
    const target = chartRow(0)
    Scene.scene(
      { update, view: Scene.withViewInputs(view, { item: { kind: "row", row: target } })() },
      Scene.given(init()),
      sized(0),
      Scene.expectAll(Scene.all.selector("path.recharts-rectangle")).toHaveCount(12),
      Scene.click(Scene.role("button", { name: "desktop" })),
      Scene.expect(Scene.role("button", { name: "desktop" })).toHaveAttr("aria-pressed", "false"),
      Scene.expectAll(Scene.all.selector("path.recharts-rectangle")).toHaveCount(6),
      Scene.expect(Scene.text("50")).toExist(),
    )
  })
})
