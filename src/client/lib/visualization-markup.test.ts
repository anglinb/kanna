import { describe, expect, test } from "bun:test"
import {
  arrowHead,
  drawMarks,
  EMPTY_MARKUP,
  fitMarkupStage,
  imagePoint,
  isMeaningfulMark,
  markupReducer,
  type Mark,
  type MarkupContext,
} from "./visualization-markup"

const red = "#ef4444"

describe("imagePoint", () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 }

  test("maps a point on the shown image to the image's pixels", () => {
    // Shown at a quarter of 1600x1200.
    expect(imagePoint(300, 200, rect, 1600, 1200)).toEqual({ x: 800, y: 600 })
    expect(imagePoint(100, 50, rect, 1600, 1200)).toEqual({ x: 0, y: 0 })
  })

  test("holds a point dragged past the edge to the edge", () => {
    expect(imagePoint(0, 1000, rect, 1600, 1200)).toEqual({ x: 0, y: 1200 })
    expect(imagePoint(900, -20, rect, 1600, 1200)).toEqual({ x: 1600, y: 0 })
  })
})

describe("arrowHead", () => {
  test("puts the head's corners behind the tip, either side of the shaft", () => {
    const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20)!
    for (const corner of head) expect(corner.x).toBeLessThan(100)
    expect(head[0].y).toBeCloseTo(-head[1].y)
    expect(Math.hypot(100 - head[0].x, head[0].y)).toBeCloseTo(20)
  })

  test("is never longer than the arrow", () => {
    const head = arrowHead({ x: 0, y: 0 }, { x: 5, y: 0 }, 20)!
    expect(Math.hypot(5 - head[0].x, head[0].y)).toBeCloseTo(5)
  })

  test("is nothing for an arrow with no length", () => {
    expect(arrowHead({ x: 3, y: 3 }, { x: 3, y: 3 }, 20)).toBeNull()
  })
})

describe("isMeaningfulMark", () => {
  test("drops a click with the arrow or box tool, and an empty label", () => {
    expect(isMeaningfulMark({ kind: "box", color: red, width: 6, from: { x: 0, y: 0 }, to: { x: 4, y: 4 } })).toBe(false)
    expect(isMeaningfulMark({ kind: "arrow", color: red, width: 6, from: { x: 0, y: 0 }, to: { x: 40, y: 0 } })).toBe(true)
    expect(isMeaningfulMark({ kind: "text", color: red, size: 36, at: { x: 0, y: 0 }, text: "  " })).toBe(false)
  })

  test("keeps a pen tap, as a dot", () => {
    expect(isMeaningfulMark({ kind: "pen", color: red, width: 6, points: [{ x: 1, y: 1 }] })).toBe(true)
  })
})

describe("markupReducer", () => {
  const box: Mark = { kind: "box", color: red, width: 6, from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }
  const label: Mark = { kind: "text", color: red, size: 36, at: { x: 10, y: 10 }, text: "Here" }

  test("adds, and undoes back to empty", () => {
    let state = markupReducer(EMPTY_MARKUP, { type: "add", mark: box })
    state = markupReducer(state, { type: "add", mark: label })
    expect(state.marks).toEqual([box, label])
    state = markupReducer(state, { type: "undo" })
    expect(state.marks).toEqual([box])
    state = markupReducer(state, { type: "undo" })
    expect(state).toEqual(EMPTY_MARKUP)
    expect(markupReducer(state, { type: "undo" })).toBe(state)
  })

  test("undoes a clear", () => {
    let state = markupReducer(EMPTY_MARKUP, { type: "add", mark: box })
    state = markupReducer(state, { type: "clear" })
    expect(state.marks).toEqual([])
    state = markupReducer(state, { type: "undo" })
    expect(state.marks).toEqual([box])
  })

  test("leaves the history alone for what changes nothing", () => {
    expect(markupReducer(EMPTY_MARKUP, { type: "clear" })).toBe(EMPTY_MARKUP)
    const empty: Mark = { kind: "text", color: red, size: 36, at: { x: 0, y: 0 }, text: "" }
    expect(markupReducer(EMPTY_MARKUP, { type: "add", mark: empty })).toBe(EMPTY_MARKUP)
  })
})

function recorder() {
  const calls: string[] = []
  const context = new Proxy({} as Record<string, unknown>, {
    get: (target, name: string) => target[name] ?? ((...args: unknown[]) => { calls.push(`${name}(${args.map(arg => typeof arg === "number" ? Math.round(arg) : arg).join(",")})`) }),
    set: (target, name: string, value) => { target[name] = value; calls.push(`${name}=${value}`); return true },
  })
  return { context: context as unknown as MarkupContext, calls }
}

describe("drawMarks", () => {
  test("strokes a pen line through its points, and a single point as a dot", () => {
    const { context, calls } = recorder()
    drawMarks(context, [
      { kind: "pen", color: red, width: 4, points: [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }] },
      { kind: "pen", color: red, width: 4, points: [{ x: 7, y: 7 }] },
    ])
    expect(calls).toContain("moveTo(0,0)")
    expect(calls).toContain("lineTo(10,5)")
    expect(calls).toContain("lineTo(20,0)")
    expect(calls).toContain("stroke()")
    expect(calls).toContain("arc(7,7,2,0,6)")
    expect(calls).toContain("fill()")
  })

  test("draws a box from any two corners", () => {
    const { context, calls } = recorder()
    drawMarks(context, [{ kind: "box", color: red, width: 4, from: { x: 50, y: 40 }, to: { x: 10, y: 20 } }])
    expect(calls).toContain("strokeRect(10,20,40,20)")
  })

  test("draws an arrow's shaft and a filled head at its tip", () => {
    const { context, calls } = recorder()
    drawMarks(context, [{ kind: "arrow", color: red, width: 4, from: { x: 0, y: 0 }, to: { x: 100, y: 0 } }])
    expect(calls.filter(call => call === "moveTo(100,0)")).toHaveLength(1)
    expect(calls).toContain("lineTo(100,0)")
    expect(calls).toContain("closePath()")
    expect(calls).toContain("fill()")
  })

  test("draws a label in its color over a halo, at its own size", () => {
    const { context, calls } = recorder()
    drawMarks(context, [{ kind: "text", color: red, size: 36, at: { x: 5, y: 6 }, text: "Spike" }])
    expect(calls.some(call => call.startsWith("font=600 36px"))).toBe(true)
    const halo = calls.indexOf("strokeText(Spike,5,6)")
    const fill = calls.indexOf("fillText(Spike,5,6)")
    expect(halo).toBeGreaterThan(-1)
    expect(fill).toBeGreaterThan(halo)
    expect(calls.slice(halo, fill)).toContain(`fillStyle=${red}`)
  })

  test("keeps each mark's state to itself", () => {
    const { context, calls } = recorder()
    drawMarks(context, [
      { kind: "box", color: red, width: 4, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { kind: "box", color: red, width: 4, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
    ])
    expect(calls.filter(call => call === "save()")).toHaveLength(2)
    expect(calls.filter(call => call === "restore()")).toHaveLength(2)
  })
})

describe("fitMarkupStage", () => {
  test("shows all of a tall capture in the stage", () => {
    const fit = fitMarkupStage(1600, 6000, 1000, 600)
    expect(fit.height).toBe(600)
    expect(fit.width).toBe(160)
  })

  test("shows a small capture at no more than half its pixels", () => {
    expect(fitMarkupStage(800, 400, 2000, 2000)).toEqual({ width: 400, height: 200, scale: 0.5 })
  })

  test("is nothing until there is a stage and an image", () => {
    expect(fitMarkupStage(800, 400, 0, 600).scale).toBe(0)
    expect(fitMarkupStage(0, 0, 1000, 600).scale).toBe(0)
  })
})
