/**
 * Radix's pointer grace area (react-tooltip, react-menu): when the pointer
 * leaves one element toward another, the hull between the exit point and the
 * target's rectangle counts as still inside, so crossing the gap doesn't
 * close a hoverable tooltip.
 */

export interface Point {
  x: number
  y: number
}
export type Polygon = Point[]
type ExitSide = "top" | "bottom" | "left" | "right"

function getExitSideFromRect(point: Point, rect: DOMRect): ExitSide {
  const top = Math.abs(rect.top - point.y)
  const bottom = Math.abs(rect.bottom - point.y)
  const right = Math.abs(rect.right - point.x)
  const left = Math.abs(rect.left - point.x)
  switch (Math.min(top, bottom, right, left)) {
    case left:
      return "left"
    case right:
      return "right"
    case top:
      return "top"
    default:
      return "bottom"
  }
}

function getPaddedExitPoints(exitPoint: Point, exitSide: ExitSide, padding = 5): Point[] {
  switch (exitSide) {
    case "top":
      return [{ x: exitPoint.x - padding, y: exitPoint.y + padding }, { x: exitPoint.x + padding, y: exitPoint.y + padding }]
    case "bottom":
      return [{ x: exitPoint.x - padding, y: exitPoint.y - padding }, { x: exitPoint.x + padding, y: exitPoint.y - padding }]
    case "left":
      return [{ x: exitPoint.x + padding, y: exitPoint.y - padding }, { x: exitPoint.x + padding, y: exitPoint.y + padding }]
    case "right":
      return [{ x: exitPoint.x - padding, y: exitPoint.y - padding }, { x: exitPoint.x - padding, y: exitPoint.y + padding }]
  }
}

function getPointsFromRect(rect: DOMRect): Point[] {
  const { top, right, bottom, left } = rect
  return [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }]
}

export function isPointInPolygon(point: Point, polygon: Polygon) {
  const { x, y } = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ii = polygon[i]!
    const jj = polygon[j]!
    const intersect = ii.y > y !== jj.y > y && x < ((jj.x - ii.x) * (y - ii.y)) / (jj.y - ii.y) + ii.x
    if (intersect) inside = !inside
  }
  return inside
}

function getHullPresorted(points: Point[]): Point[] {
  if (points.length <= 1) return points.slice()
  const upperHull: Point[] = []
  for (const p of points) {
    while (upperHull.length >= 2) {
      const q = upperHull[upperHull.length - 1]!
      const r = upperHull[upperHull.length - 2]!
      if ((q.x - r.x) * (p.y - r.y) >= (q.y - r.y) * (p.x - r.x)) upperHull.pop()
      else break
    }
    upperHull.push(p)
  }
  upperHull.pop()
  const lowerHull: Point[] = []
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i]!
    while (lowerHull.length >= 2) {
      const q = lowerHull[lowerHull.length - 1]!
      const r = lowerHull[lowerHull.length - 2]!
      if ((q.x - r.x) * (p.y - r.y) >= (q.y - r.y) * (p.x - r.x)) lowerHull.pop()
      else break
    }
    lowerHull.push(p)
  }
  lowerHull.pop()
  if (upperHull.length === 1 && lowerHull.length === 1 && upperHull[0]!.x === lowerHull[0]!.x && upperHull[0]!.y === lowerHull[0]!.y) {
    return upperHull
  }
  return upperHull.concat(lowerHull)
}

function getHull(points: Point[]) {
  const sorted = points.slice().sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : a.y < b.y ? -1 : a.y > b.y ? 1 : 0))
  return getHullPresorted(sorted)
}

/** The grace polygon for a pointer that left `from` at `exitPoint`, heading for `to`. */
export function graceArea(exitPoint: Point, from: Element, to: Element): Polygon {
  const exitSide = getExitSideFromRect(exitPoint, from.getBoundingClientRect())
  return getHull([...getPaddedExitPoints(exitPoint, exitSide), ...getPointsFromRect(to.getBoundingClientRect())])
}
