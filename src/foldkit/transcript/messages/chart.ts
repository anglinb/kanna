import "../../../client/components/messages/chart-tool.css"
import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { CHART_COLORS, resolveChartKeys, type ChartToolPayload } from "../../../shared/display-tools"
import { buttonClass } from "../../ui/button"
import { Download, Maximize2 } from "../../ui/icons"
import { domStream } from "../../ui/overlay/stream"
import type { RowContext } from "./context"
import { chartOf, Message, type ChartState } from "./model"

/**
 * ChartTool.tsx: a `show_chart` call's card, its chart drawn as recharts
 * draws it (the same SVG, element for element, with the same numbers),
 * without recharts. The chart's state (hidden series, the one under the
 * legend's pointer, the pointer over the plot, the measured size and the
 * tooltip's box) is the Model's, by row (`charts[key]`); the `ChartArea`
 * Mount measures and reports the pointer.
 *
 * What is ported from recharts 3.8 is what these four charts use, at their
 * settings: nice ticks (getNiceTickValues), the band and point scales, bar
 * positions (combineAllBarPositions), d3's monotone curve with d3-path's
 * 3-digit rounding, sector paths, the axis-tooltip index and the tooltip's
 * placement. Not ported: tick thinning for labels that collide (recharts'
 * `preserveEnd`), which these charts' labels never need at the widths the
 * transcript has.
 */

// ── The data (copied from ChartTool.tsx) ─────────────────────────────────

export function csvCell(value: unknown): string {
  const text = String(value ?? "")
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '\"\"')}"` : text
}

export function formatChartCell(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("en-US", { maximumFractionDigits: value % 1 === 0 ? 0 : 2 })
  }
  return value ?? ""
}

type ChartConfigMap = Record<string, { label?: string; color: string }>
export type AggregateMode = "avg" | "bottom_quartile" | "median" | "top_quartile" | "min" | "max" | "sum" | "count"
export interface ChartTableRow {
  key: string
  color?: string
  cells: Array<string | number>
  values: Array<number | null>
}
export interface ChartTableData {
  headers: string[]
  rows: ChartTableRow[]
}

const CHART_SERIES_COLORS = CHART_COLORS

export const AGGREGATE_OPTIONS: Array<{ value: AggregateMode; label: string }> = [
  { value: "avg", label: "Avg" },
  { value: "bottom_quartile", label: "Bottom Quartile" },
  { value: "median", label: "Median" },
  { value: "top_quartile", label: "Top Quartile" },
  { value: "min", label: "Min" },
  { value: "max", label: "Max" },
  { value: "sum", label: "Sum" },
  { value: "count", label: "Count" },
]

function percentile(sortedValues: number[], percentileValue: number) {
  if (!sortedValues.length) return 0
  if (sortedValues.length === 1) return sortedValues[0]!
  const index = (sortedValues.length - 1) * percentileValue
  const lowerIndex = Math.floor(index)
  const upperIndex = Math.ceil(index)
  const weight = index - lowerIndex
  return sortedValues[lowerIndex]! * (1 - weight) + sortedValues[upperIndex]! * weight
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function shouldHideDecimalValues(data: ReadonlyArray<Record<string, string | number | null>>, numericKeys: string[]): boolean {
  const values = data.flatMap((row) => (
    numericKeys
      .map((key) => row[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value !== 0)
      .map((value) => Math.abs(value))
  ))
  const medianValue = median(values)
  return medianValue !== null && medianValue >= 1_000
}

function formatCompact(value: number, hideDecimals = false): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(hideDecimals || abs >= 10_000_000_000 ? 0 : 1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(hideDecimals || abs >= 10_000_000 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(hideDecimals || abs >= 10_000 ? 0 : 1)}K`
  if (hideDecimals) return Math.round(value).toLocaleString()
  return value % 1 === 0 ? String(value) : value.toFixed(1)
}

function estimateYAxisWidth(data: ReadonlyArray<Record<string, string | number | null>>, dataKeys: string[], hideDecimals = false): number {
  let maxLen = 1
  for (const row of data) {
    for (const key of dataKeys) {
      const value = row[key]
      if (typeof value !== "number") continue
      maxLen = Math.max(maxLen, formatCompact(value, hideDecimals).length)
    }
  }
  return Math.max(32, maxLen * 8 + 16)
}

export function aggregateValues(values: Array<number | null>, mode: AggregateMode): number | string {
  const numeric = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  if (!numeric.length) return ""
  const rounded = (value: number) => Number(value.toFixed(2))
  switch (mode) {
    case "count":
      return numeric.length
    case "sum":
      return rounded(numeric.reduce((sum, value) => sum + value, 0))
    case "min":
      return rounded(Math.min(...numeric))
    case "max":
      return rounded(Math.max(...numeric))
    case "bottom_quartile":
    case "median":
    case "top_quartile": {
      const sorted = [...numeric].sort((a, b) => a - b)
      if (mode === "bottom_quartile") return rounded(percentile(sorted, 0.25))
      if (mode === "top_quartile") return rounded(percentile(sorted, 0.75))
      return rounded(percentile(sorted, 0.5))
    }
    case "avg":
      return rounded(numeric.reduce((sum, value) => sum + value, 0) / numeric.length)
  }
}

function toNumericValue(value: string | number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function slug(title: string | undefined) {
  return (title || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

/** Everything a chart view needs from its payload (useChartModel, without its state). */
export interface ChartModel {
  payload: ChartToolPayload
  data: ReadonlyArray<Record<string, string | number | null>>
  xKey: string
  keys: string[]
  config: ChartConfigMap
  hideDecimalValues: boolean
  yAxisWidth: number
  csv: string
  csvFilename: string
  chartTable: ChartTableData
  tableCsv: string
  tableCsvFilename: string
  legendItems: Array<{ key: string; label: string; color: string | undefined }>
}

export function chartModel(payload: ChartToolPayload): ChartModel {
  const data = payload.data ?? []
  const firstRow = data[0] ?? {}
  const { xKey, keys } = resolveChartKeys(payload)
  const config = Object.fromEntries(keys.map((key, index) => [key, { label: payload.config?.[key]?.label ?? key, color: payload.config?.[key]?.color ?? CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]! }])) as ChartConfigMap
  const hideDecimalValues = shouldHideDecimalValues(data, keys)
  const yAxisWidth = estimateYAxisWidth(data, keys, hideDecimalValues)
  const csvKeys = [...new Set(data.flatMap((row) => Object.keys(row)))]
  const csv = [csvKeys, ...data.map((row) => csvKeys.map((key) => row[key] ?? ""))].map((row) => row.map(csvCell).join(",")).join("\n")
  const chartTable: ChartTableData = (() => {
    if (payload.type === "pie") {
      const valueKey = keys[0] ?? Object.keys(firstRow).find((key) => typeof firstRow[key] === "number") ?? "value"
      return {
        headers: ["Series", "Value"],
        rows: data.map((row, index) => ({
          key: String(row[xKey] ?? `Segment ${index + 1}`),
          color: CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length],
          cells: [String(row[xKey] ?? `Segment ${index + 1}`), formatChartCell(row[valueKey])],
          values: [toNumericValue(row[valueKey])],
        })),
      }
    }
    return {
      headers: ["Series", ...data.map((row, index) => String(row[xKey] ?? `Point ${index + 1}`))],
      rows: keys.map((key) => {
        const values = data.map((row) => row[key])
        return {
          key,
          color: config[key]!.color,
          cells: [config[key]!.label ?? key, ...values.map(formatChartCell)],
          values: values.map(toNumericValue),
        }
      }),
    }
  })()
  const tableCsv = [chartTable.headers, ...chartTable.rows.map((row) => row.cells)].map((row) => row.map((value) => {
    const text = String(value ?? "")
    return text.includes(",") || text.includes("\"") || text.includes("\n")
      ? `"${text.replace(/"/g, "\"\"")}"`
      : text
  }).join(",")).join("\n")
  const legendItems = payload.type === "pie"
    ? chartTable.rows.map((row) => ({ key: row.key, label: String(row.cells[0]), color: row.color }))
    : keys.map((key) => ({ key, label: config[key]!.label ?? key, color: config[key]!.color }))
  return {
    payload,
    data,
    xKey,
    keys,
    config,
    hideDecimalValues,
    yAxisWidth,
    csv,
    csvFilename: `${slug(payload.title)}.csv`,
    chartTable,
    tableCsv,
    tableCsvFilename: `${slug(payload.title) || "chart"}_table.csv`,
    legendItems,
  }
}

// ── recharts' arithmetic ─────────────────────────────────────────────────

/** recharts' `round`: 4 decimals, no negative zero. */
function round(value: number, precision = 4) {
  const factor = 10 ** precision
  const rounded = Math.round(value * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}

/** recharts' `roundTemplateLiteral`: each number rounded. */
function roundTemplate(strings: TemplateStringsArray, ...values: Array<number | string>) {
  return strings.reduce((result, part, index) => {
    const value = values[index - 1]
    if (typeof value === "string") return result + value + part
    if (value !== undefined) return result + round(value) + part
    return result + part
  }, "")
}

/** d3-path's numbers at 3 digits (d3-shape's default). */
function d3Round(value: number) {
  return Math.round(value * 1000) / 1000
}

/**
 * Decimal arithmetic for the tick steps, as decimal.js-light does it there:
 * the steps are tidy decimals, and binary floats would print 0.30000000000000004.
 */
function tidy(value: number) {
  return Number.parseFloat(value.toPrecision(15))
}

function digitCount(value: number) {
  return value === 0 ? 1 : Math.floor(Math.log10(Math.abs(value))) + 1
}

function adaptiveStep(roughStep: number, correctionFactor: number) {
  if (roughStep <= 0) return 0
  const count = digitCount(roughStep)
  const digitCountValue = 10 ** count
  const stepRatio = tidy(roughStep / digitCountValue)
  const stepRatioScale = count !== 1 ? 0.05 : 0.1
  const amendStepRatio = tidy((Math.ceil(tidy(stepRatio / stepRatioScale)) + correctionFactor) * stepRatioScale)
  return tidy(amendStepRatio * digitCountValue)
}

function calculateStep(min: number, max: number, tickCount: number, correctionFactor = 0): { step: number; tickMin: number; tickMax: number } {
  if (!Number.isFinite((max - min) / (tickCount - 1))) return { step: 0, tickMin: 0, tickMax: 0 }
  const step = adaptiveStep(tidy((max - min) / (tickCount - 1)), correctionFactor)
  let middle: number
  if (min <= 0 && max >= 0) {
    middle = 0
  } else {
    middle = tidy((min + max) / 2)
    middle = tidy(middle - (middle % step))
  }
  let belowCount = Math.ceil(tidy((middle - min) / step))
  let upCount = Math.ceil(tidy((max - middle) / step))
  const scaleCount = belowCount + upCount + 1
  if (scaleCount > tickCount) return calculateStep(min, max, tickCount, correctionFactor + 1)
  if (scaleCount < tickCount) {
    upCount = max > 0 ? upCount + (tickCount - scaleCount) : upCount
    belowCount = max > 0 ? belowCount : belowCount + (tickCount - scaleCount)
  }
  return { step, tickMin: tidy(middle - belowCount * step), tickMax: tidy(middle + upCount * step) }
}

/** getNiceTickValues([min, max], tickCount, allowDecimals = true). */
export function niceTicks(min: number, max: number, tickCount = 5): number[] {
  const count = Math.max(tickCount, 2)
  const [low, high] = min > max ? [max, min] : [min, max]
  if (low === high) {
    // getTickOfSingleValue, for an integer (or zero) value: a step of 1 around it.
    const middle = low === 0 ? Math.floor((tickCount - 1) / 2) : Math.floor(low)
    const middleIndex = Math.floor((tickCount - 1) / 2)
    return Array.from({ length: tickCount }, (_, index) => middle + (index - middleIndex))
  }
  const { step, tickMin, tickMax } = calculateStep(low, high, count)
  const values: number[] = []
  const end = tidy(tickMax + 0.1 * step)
  for (let value = tickMin, index = 0; value < end && index < 100000; value = tidy(value + step), index++) values.push(value)
  return min > max ? values.reverse() : values
}

const RADIAN = Math.PI / 180

function polarToCartesian(cx: number, cy: number, radius: number, angle: number) {
  return { x: cx + Math.cos(-RADIAN * angle) * radius, y: cy + Math.sin(-RADIAN * angle) * radius }
}

/** d3's curveMonotoneX, into a d3-path string at 3 digits. Copied from d3-shape. */
function monotonePath(points: ReadonlyArray<{ x: number; y: number }>, context: PathContext) {
  const sign = (x: number) => (x < 0 ? -1 : 1)
  let x0 = Number.NaN, y0 = Number.NaN, x1 = Number.NaN, y1 = Number.NaN, t0 = Number.NaN
  let state = 0
  const slope3 = (x2: number, y2: number) => {
    const h0 = x1 - x0
    const h1 = x2 - x1
    const s0 = (y1 - y0) / (h0 || (h1 < 0 ? -0 : 0))
    const s1 = (y2 - y1) / (h1 || (h0 < 0 ? -0 : 0))
    const p = (s0 * h1 + s1 * h0) / (h0 + h1)
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  }
  const slope2 = (t: number) => {
    const h = x1 - x0
    return h ? (3 * (y1 - y0) / h - t) / 2 : t
  }
  const bezier = (from: number, to: number) => {
    const dx = (x1 - x0) / 3
    context.curve(x0 + dx, y0 + dx * from, x1 - dx, y1 - dx * to, x1, y1)
  }
  for (const { x, y } of points) {
    let t1 = Number.NaN
    if (x === x1 && y === y1) continue
    switch (state) {
      case 0:
        state = 1
        context.start(x, y)
        break
      case 1:
        state = 2
        break
      case 2:
        state = 3
        t1 = slope3(x, y)
        bezier(slope2(t1), t1)
        break
      default:
        t1 = slope3(x, y)
        bezier(t0, t1)
        break
    }
    x0 = x1; x1 = x
    y0 = y1; y1 = y
    t0 = t1
  }
  if (state === 2) context.line(x1, y1)
  else if (state === 3) bezier(t0, slope2(t0))
}

interface PathContext {
  start(x: number, y: number): void
  line(x: number, y: number): void
  curve(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
}

function d3Path() {
  let path = ""
  let started = false
  const context: PathContext & { close(): void; value(): string; lineOrMove(x: number, y: number): void } = {
    start: (x, y) => { path += `M${d3Round(x)},${d3Round(y)}`; started = true },
    line: (x, y) => { path += `L${d3Round(x)},${d3Round(y)}` },
    lineOrMove: (x, y) => (started ? context.line(x, y) : context.start(x, y)),
    curve: (x1, y1, x2, y2, x, y) => { path += `C${d3Round(x1)},${d3Round(y1)},${d3Round(x2)},${d3Round(y2)},${d3Round(x)},${d3Round(y)}` },
    close: () => { path += "Z" },
    value: () => path,
  }
  return context
}

/** A monotone line through the defined points, split where a value is missing (d3's `defined`). */
function linePath(points: ReadonlyArray<{ x: number; y: number | null }>) {
  const path = d3Path()
  let run: Array<{ x: number; y: number }> = []
  const flush = () => {
    if (run.length > 0) monotonePath(run, path)
    run = []
  }
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) flush()
    else run.push({ x: point.x, y: point.y })
  }
  flush()
  return path.value()
}

/**
 * d3's area with a monotone curve: the top line forward, then the base line
 * backward through the same curve, closed. As d3 runs it: the curve's
 * `areaStart`, the forward line, then the reversed base continuing from it.
 */
function areaPath(points: ReadonlyArray<{ x: number; y: number | null; base: number }>) {
  const path = d3Path()
  let run: Array<{ x: number; y: number; base: number }> = []
  const flush = () => {
    if (run.length === 0) return
    monotonePath(run.map(({ x, y }) => ({ x, y })), path)
    // The base, backward, continues the same subpath: its first point is a lineTo.
    monotonePath(run.slice().reverse().map(({ x, base }) => ({ x, y: base })), {
      start: (x, y) => path.line(x, y),
      line: path.line,
      curve: path.curve,
    })
    path.close()
    run = []
  }
  for (const point of points) {
    if (point.y === null || !Number.isFinite(point.y)) flush()
    else run.push({ x: point.x, y: point.y, base: point.base })
  }
  flush()
  return path.value()
}

/** Rectangle.tsx's path (getRectanglePath) for a uniform radius, or square. */
function rectanglePath(x: number, y: number, width: number, height: number, radius: number) {
  const maxRadius = Math.min(Math.abs(round(width)) / 2, Math.abs(round(height)) / 2)
  const ySign = round(height) >= 0 ? 1 : -1
  const xSign = round(width) >= 0 ? 1 : -1
  const clockWise = (round(height) >= 0 && round(width) >= 0) || (round(height) < 0 && round(width) < 0) ? 1 : 0
  if (maxRadius > 0 && radius > 0) {
    const r = Math.min(maxRadius, radius)
    return roundTemplate`M ${x},${y + ySign * r}
            A ${r},${r},0,0,${clockWise},${x + xSign * r},${y}
            L ${x + width - xSign * r},${y}
            A ${r},${r},0,0,${clockWise},${x + width},${y + ySign * r}
            L ${x + width},${y + height - ySign * r}
            A ${r},${r},0,0,${clockWise},${x + width - xSign * r},${y + height}
            L ${x + xSign * r},${y + height}
            A ${r},${r},0,0,${clockWise},${x},${y + height - ySign * r} Z`
  }
  return roundTemplate`M ${x},${y} h ${width} v ${height} h ${-width} Z`
}

/** Sector.tsx's path (getSectorPath), with an inner radius. */
function sectorPath(cx: number, cy: number, innerRadius: number, outerRadius: number, startAngle: number, endAngle: number) {
  const sign = Math.sign(endAngle - startAngle) || 0
  const angle = sign * Math.min(Math.abs(endAngle - startAngle), 359.999)
  const tempEndAngle = startAngle + angle
  const outerStart = polarToCartesian(cx, cy, outerRadius, startAngle)
  const outerEnd = polarToCartesian(cx, cy, outerRadius, tempEndAngle)
  let path = roundTemplate`M ${outerStart.x},${outerStart.y}
    A ${outerRadius},${outerRadius},0,
    ${+(Math.abs(angle) > 180)},${+(startAngle > tempEndAngle)},
    ${outerEnd.x},${outerEnd.y}
  `
  if (innerRadius > 0) {
    const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle)
    const innerEnd = polarToCartesian(cx, cy, innerRadius, tempEndAngle)
    path += roundTemplate`L ${innerEnd.x},${innerEnd.y}
            A ${innerRadius},${innerRadius},0,
            ${+(Math.abs(angle) > 180)},${+(startAngle <= tempEndAngle)},
            ${innerStart.x},${innerStart.y} Z`
  } else {
    path += roundTemplate`L ${cx},${cy} Z`
  }
  return path
}

// ── Layout ───────────────────────────────────────────────────────────────

interface Offset { left: number; top: number; width: number; height: number }

const MARGIN = { top: 12, right: 12, left: 12, bottom: 0 }
const X_AXIS_HEIGHT = 30
const TICK_SIZE = 6
const TICK_MARGIN = 8

interface Cartesian {
  kind: "cartesian"
  offset: Offset
  domain: [number, number]
  yTicks: number[]
  y: (value: number) => number
  /** Category centres (band) or points, by data index. */
  xs: number[]
  bandSize: number
  visible: string[]
  /** Stacked tops and bases, by key, by index. */
  stacks: Record<string, Array<{ top: number | null; base: number }>>
}

interface Polar {
  kind: "polar"
  offset: Offset
  cx: number
  cy: number
  innerRadius: number
  outerRadius: number
  sectors: Array<{ name: string; value: number; startAngle: number; endAngle: number; color: string; tooltip: { x: number; y: number } }>
}

function cartesianLayout(model: ChartModel, chart: ChartState, width: number, height: number): Cartesian {
  const { payload, data, keys } = model
  const offset: Offset = {
    left: MARGIN.left + model.yAxisWidth,
    top: MARGIN.top,
    width: width - MARGIN.left - MARGIN.right - model.yAxisWidth,
    height: height - MARGIN.top - MARGIN.bottom - X_AXIS_HEIGHT,
  }
  const visible = keys.filter((key) => !chart.hidden.includes(key))
  const stacked = Boolean(payload.stacked) && payload.type !== "line"
  // Each visible series' value at each point, stacked from the previous visible series when stacked.
  const stacks: Cartesian["stacks"] = {}
  const running = data.map(() => 0)
  for (const key of visible) {
    stacks[key] = data.map((row, index) => {
      const value = toNumericValue(row[key])
      if (!stacked) return { top: value, base: 0 }
      const base = running[index]!
      const top = value === null ? null : base + value
      if (value !== null) running[index] = base + value
      return { top, base }
    })
  }
  const values = visible.flatMap((key) => stacks[key]!.flatMap(({ top, base }) => (top === null ? [] : stacked ? [top, base] : [top])))
  const dataMin = values.length ? Math.min(0, ...values) : 0
  const dataMax = values.length ? Math.max(...values) : 0
  const yTicks = niceTicks(dataMin, dataMax, 5)
  const domain: [number, number] = [yTicks[0] ?? 0, yTicks[yTicks.length - 1] ?? 0]
  const bottom = offset.top + offset.height
  const y = (value: number) => (domain[1] === domain[0]
    ? bottom - offset.height / 2
    : bottom + ((value - domain[0]) / (domain[1] - domain[0])) * (offset.top - bottom))
  const count = data.length
  const band = payload.type === "bar"
  const bandSize = band ? offset.width / Math.max(1, count) : count > 1 ? offset.width / (count - 1) : 0
  const xs = data.map((_, index) => (band
    ? offset.left + index * bandSize + bandSize / 2
    : count > 1 ? offset.left + index * bandSize : offset.left + offset.width / 2))
  return { kind: "cartesian", offset, domain, yTicks, y, xs, bandSize, visible, stacks }
}

function polarLayout(model: ChartModel, width: number, height: number): Polar {
  const margin = 12
  const offset: Offset = { left: margin, top: margin, width: width - 2 * margin, height: height - 2 * margin }
  const cx = offset.left + offset.width / 2
  const cy = offset.top + offset.height / 2
  const maxRadius = Math.min(offset.width, offset.height) / 2
  const innerRadius = maxRadius * 0.45
  const outerRadius = maxRadius * 0.75
  const dataKey = model.keys[0]
  const values = model.data.map((row) => (dataKey ? row[dataKey] : undefined))
  const sum = values.reduce<number>((total, value) => total + (typeof value === "number" ? value : 0), 0)
  let previousEnd = 0
  const sectors = sum > 0
    ? model.data.map((row, index) => {
      const value = values[index]
      const numeric = typeof value === "number" ? value : 0
      const startAngle = index === 0 ? 0 : previousEnd
      const endAngle = startAngle + (numeric / sum) * 360
      previousEnd = endAngle
      const midAngle = (startAngle + endAngle) / 2
      return {
        name: String(row[model.xKey] ?? index),
        value: numeric,
        startAngle,
        endAngle,
        color: CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length]!,
        tooltip: polarToCartesian(cx, cy, (innerRadius + outerRadius) / 2, midAngle),
      }
    })
    : []
  return { kind: "polar", offset, cx, cy, innerRadius, outerRadius, sectors }
}

/** The category under the pointer (calculateActiveTickIndex), or null outside the plot. */
function activeIndex(layout: Cartesian, x: number, y: number): number | null {
  const { offset, xs } = layout
  if (x < offset.left || x > offset.left + offset.width || y < offset.top || y > offset.top + offset.height) return null
  const len = xs.length
  if (len === 0) return null
  if (len === 1) return 0
  for (let index = 0; index < len; index++) {
    const current = xs[index]!
    const next = xs[index + 1]
    const previous = xs[index - 1]
    if (index === 0 && next !== undefined && x <= (current + next) / 2) return index
    if (index === len - 1 && previous !== undefined && x > (current + previous) / 2) return index
    if (index > 0 && index < len - 1 && previous !== undefined && next !== undefined && x > (current + previous) / 2 && x <= (current + next) / 2) return index
  }
  return null
}

/** The sector under the pointer (the path's own hit area), or null. */
function activeSector(layout: Polar, x: number, y: number): number | null {
  const dx = x - layout.cx
  const dy = y - layout.cy
  const radius = Math.hypot(dx, dy)
  if (radius < layout.innerRadius || radius > layout.outerRadius) return null
  const angle = ((Math.atan2(-dy, dx) / RADIAN) + 360) % 360
  const index = layout.sectors.findIndex((sector) => angle >= sector.startAngle && angle < sector.endAngle)
  return index === -1 ? null : index
}

/** Where the tooltip goes (getTooltipTranslateXY), allowing no escape from the plot. */
function tooltipTranslate(coordinate: number, size: number, viewStart: number, viewSize: number, offset = 10) {
  const negative = coordinate - size - offset
  const positive = coordinate + offset
  if (positive + size > viewStart + viewSize) return Math.max(negative, viewStart)
  return Math.max(positive, viewStart)
}

// ── The Mount ────────────────────────────────────────────────────────────

/**
 * On the responsive container: its size, rounded (ResponsiveContainer), and
 * the pointer over the chart, relative to it and rounded
 * (getRelativeCoordinate). On the tooltip, its box once drawn.
 */
const ChartArea = Mount.defineStream("ChartArea", {
  args: { key: Schema.String },
  messages: [Message.MeasuredChart, Message.MovedOverChart, Message.MeasuredChartTooltip],
  execute: ({ element, key }) =>
    domStream<typeof Message.MeasuredChart.Type | typeof Message.MovedOverChart.Type | typeof Message.MeasuredChartTooltip.Type>((emit) => {
      const container = element as HTMLElement
      let last = { width: -1, height: -1 }
      const size = (width: number, height: number) => {
        const next = { width: Math.round(width), height: Math.round(height) }
        if (next.width === last.width && next.height === last.height) return
        last = next
        emit(Message.MeasuredChart({ key, ...next }))
      }
      const rect = container.getBoundingClientRect()
      size(rect.width, rect.height)
      const observer = typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(([entry]) => { if (entry) size(entry.contentRect.width, entry.contentRect.height) })
      observer?.observe(container)

      let frame = 0
      const onMove = (event: MouseEvent) => {
        const wrapper = container.querySelector<HTMLElement>(".recharts-wrapper")
        if (!wrapper) return
        const box = wrapper.getBoundingClientRect()
        const x = Math.round(event.clientX - box.left)
        const y = Math.round(event.clientY - box.top)
        cancelAnimationFrame(frame)
        frame = requestAnimationFrame(() => emit(Message.MovedOverChart({ key, pointer: { x, y } })))
      }
      const onLeave = () => {
        cancelAnimationFrame(frame)
        emit(Message.MovedOverChart({ key, pointer: null }))
      }
      container.addEventListener("mousemove", onMove)
      container.addEventListener("mouseleave", onLeave)

      // The tooltip's box, whenever what it holds changes.
      let tooltipBox = { width: -1, height: -1 }
      const measureTooltip = () => {
        const tooltip = container.querySelector<HTMLElement>(".recharts-tooltip-wrapper")
        if (!tooltip) return
        const box = tooltip.getBoundingClientRect()
        if (Math.abs(box.width - tooltipBox.width) <= 1 && Math.abs(box.height - tooltipBox.height) <= 1) return
        tooltipBox = { width: box.width, height: box.height }
        emit(Message.MeasuredChartTooltip({ key, width: box.width, height: box.height }))
      }
      const tooltipObserver = new MutationObserver(measureTooltip)
      tooltipObserver.observe(container, { childList: true, subtree: true, characterData: true })
      return () => {
        cancelAnimationFrame(frame)
        observer?.disconnect()
        tooltipObserver.disconnect()
        container.removeEventListener("mousemove", onMove)
        container.removeEventListener("mouseleave", onLeave)
      }
    }),
})

// ── The view ─────────────────────────────────────────────────────────────

function attributes(record: Record<string, string | number>, h: HtmlBuilder<Message>): Attribute<Message>[] {
  return Object.entries(record).map(([name, value]) => h.Attribute(name, String(value)))
}

/** An id recharts would give the element: unique per chart and series. */
function idFor(key: string, part: string) {
  return `${part}-${key.replace(/[^\w-]/g, "_")}`
}

const TICK_FILL = "hsl(var(--muted-foreground))"
const ZINDEX_LAYERS = [-100, -50, "defs", 100, 200, 300, 400, 500, 600, 1000, 1100, 1200, 2000] as const

function layers(contents: Partial<Record<number, ReadonlyArray<Html>>>, defs: Html, h: HtmlBuilder<Message>): Html[] {
  return ZINDEX_LAYERS.map((layer) => (layer === "defs"
    ? defs
    : h.g([h.Attribute("tabindex", "-1"), h.Class(`recharts-zIndex-layer_${layer}`)], [...(contents[layer] ?? [])])))
}

function clipDefs(key: string, offset: Offset, h: HtmlBuilder<Message>) {
  return h.defs([], [
    h.clipPath([h.Id(idFor(key, "recharts-clip"))], [
      h.rect(attributes({ x: offset.left, y: offset.top, height: offset.height, width: offset.width }, h)),
    ]),
  ])
}

interface Tooltip {
  label?: string
  entries: Array<{ name: string; value: string | number; color: string }>
  /** The point the tooltip is placed from. */
  coordinate: { x: number; y: number }
}

function tooltipWrapper(tooltip: Tooltip | null, chart: ChartState, offset: Offset, h: HtmlBuilder<Message>): Html {
  const measured = chart.tooltip
  const placed = tooltip && measured && measured.width > 0 && measured.height > 0
    ? {
      x: tooltipTranslate(tooltip.coordinate.x, measured.width, offset.left, offset.width),
      y: tooltipTranslate(tooltip.coordinate.y, measured.height, offset.top, offset.height),
    }
    : null
  const classes = ["recharts-tooltip-wrapper"]
  if (placed && tooltip) {
    classes.push(placed.x >= tooltip.coordinate.x ? "recharts-tooltip-wrapper-right" : "recharts-tooltip-wrapper-left")
    classes.push(placed.y >= tooltip.coordinate.y ? "recharts-tooltip-wrapper-bottom" : "recharts-tooltip-wrapper-top")
  }
  return h.div([
    h.Attribute("xmlns", "http://www.w3.org/1999/xhtml"),
    h.Attribute("tabindex", "-1"),
    h.Class(classes.join(" ")),
    h.Style({
      visibility: placed ? "visible" : "hidden",
      "pointer-events": "none",
      position: "absolute",
      top: "0px",
      left: "0px",
      ...(placed ? { transform: `translate(${placed.x}px, ${placed.y}px)` } : {}),
    }),
  ], tooltip && tooltip.entries.length > 0
    ? [h.div([h.Class("chart-tooltip")], [
      tooltip.label !== undefined ? h.div([h.Class("chart-tooltip-label")], [tooltip.label]) : null,
      h.div([h.Class("chart-tooltip-list")], tooltip.entries.map((entry) => h.div([h.Class("chart-tooltip-row")], [
        h.span([h.Class("chart-tooltip-name")], [h.i([h.Style({ "background-color": entry.color })], []), entry.name]),
        h.span([h.Class("chart-tooltip-value")], [String(formatChartCell(entry.value))]),
      ]))),
    ])]
    : [])
}

function cartesianChart(key: string, model: ChartModel, chart: ChartState, width: number, height: number, h: HtmlBuilder<Message>) {
  const layout = cartesianLayout(model, chart, width, height)
  const { offset, y, xs, bandSize, visible, stacks } = layout
  const type = model.payload.type
  const muted = (series: string) => Boolean(chart.active && chart.active !== series)
  const pointer = chart.hover
  const index = pointer ? activeIndex(layout, pointer.x, pointer.y) : null
  const bottom = offset.top + offset.height
  const dims = { width: offset.width, height: offset.height }

  const grid = h.g([h.Class("recharts-cartesian-grid")], [
    h.g([h.Class("recharts-cartesian-grid-horizontal")], layout.yTicks.map((tick) => h.line(attributes({
      stroke: "hsl(var(--border))",
      fill: "none",
      x: offset.left,
      y: offset.top,
      width: offset.width,
      height: offset.height,
      x1: offset.left,
      y1: y(tick),
      x2: offset.left + offset.width,
      y2: y(tick),
    }, h)))),
  ])

  const contents: Partial<Record<number, Html[]>> = { [-100]: [grid] }

  if (type === "bar") {
    const stacked = Boolean(model.payload.stacked)
    const groups = stacked ? (visible.length > 0 ? [visible] : []) : visible.map((series) => [series])
    const gap = groups.length > 1 ? 4 : 4
    const categoryGap = bandSize * 0.1
    let realGap = gap
    if (bandSize - 2 * categoryGap - (groups.length - 1) * realGap <= 0) realGap = 0
    let size = groups.length ? (bandSize - 2 * categoryGap - (groups.length - 1) * realGap) / groups.length : 0
    if (size > 1) size = Math.trunc(size)
    const radius = stacked ? 0 : 4
    contents[300] = visible.map((series) => {
      const position = groups.findIndex((members) => members.includes(series))
      const barOffset = categoryGap + (size + realGap) * position
      return h.g([h.Class("recharts-layer recharts-bar"), h.Id(idFor(key, `recharts-bar-${series}`))], [
        h.g([h.Class("recharts-layer recharts-bar-rectangles")], [
          h.g([h.Class("recharts-layer")], model.data.flatMap((_, dataIndex) => {
            const point = stacks[series]![dataIndex]!
            if (point.top === null) return []
            const x = offset.left + dataIndex * bandSize + barOffset
            const top = y(point.top)
            const base = y(stacked ? point.base : Math.max(layout.domain[0], Math.min(0, layout.domain[1])))
            const barY = Math.min(top, base)
            const barHeight = Math.abs(base - top)
            return [h.g([h.Class("recharts-layer recharts-bar-rectangle")], [
              h.g([h.Class("recharts-layer recharts-inactive-bar")], [
                h.path([
                  ...attributes({
                    fill: model.config[series]!.color,
                    "fill-opacity": muted(series) ? 0.18 : 1,
                    name: "undefined",
                    x: round(x),
                    y: round(barY),
                    width: round(size),
                    height: round(barHeight),
                    radius,
                  }, h),
                  h.Class("recharts-rectangle"),
                  h.Attribute("d", rectanglePath(x, barY, size, barHeight, radius)),
                ]),
              ]),
            ])]
          })),
        ]),
      ])
    })
    if (index !== null) {
      contents[200] = [h.path([
        ...attributes({ stroke: "none", "pointer-events": "none", width: bandSize, height: offset.height - 1, fill: "hsl(var(--foreground) / 0.06)", x: xs[index]! - bandSize / 2, y: offset.top + 0.5 }, h),
        h.Class("recharts-rectangle recharts-tooltip-cursor"),
        h.Attribute("radius", "0"),
        h.Attribute("d", rectanglePath(xs[index]! - bandSize / 2, offset.top + 0.5, bandSize, offset.height - 1, 0)),
      ])]
    }
  }

  if (type === "line") {
    contents[400] = visible.map((series) => h.g([h.Class("recharts-layer recharts-line")], [
      h.g([h.Class("recharts-layer recharts-shape")], [
        h.path([
          ...attributes({ stroke: model.config[series]!.color, "stroke-width": 2, "stroke-opacity": muted(series) ? 0.18 : 1, fill: "none" }, h),
          h.Id(idFor(key, `recharts-line-${series}`)),
          ...attributes(dims, h),
          h.Class("recharts-curve recharts-line-curve"),
          h.Attribute("d", linePath(xs.map((x, dataIndex) => {
            const top = stacks[series]![dataIndex]!.top
            return { x, y: top === null ? null : y(top) }
          }))),
        ]),
      ]),
    ]))
  }

  if (type === "area") {
    contents[100] = visible.map((series) => {
      const id = idFor(key, `recharts-area-${series}`)
      const points = xs.map((x, dataIndex) => {
        const point = stacks[series]![dataIndex]!
        return { x, y: point.top === null ? null : y(point.top), base: y(model.payload.stacked ? point.base : Math.max(layout.domain[0], Math.min(0, layout.domain[1]))) }
      })
      const strokeWidth = muted(series) ? 0 : 2
      const fillOpacity = muted(series) ? 0.08 : 0.25
      return h.g([h.Class("recharts-layer recharts-area")], [
        h.g([h.Class("recharts-layer")], [
          h.g([h.Class("recharts-layer"), h.Attribute("clip-path", `url(#animationClipPath-${id})`)], [
            h.g([h.Class("recharts-layer")], [
              h.path([
                ...attributes({ "stroke-width": strokeWidth, fill: model.config[series]!.color, "fill-opacity": fillOpacity, height: offset.height, stroke: "none", width: offset.width }, h),
                h.Id(id),
                h.Class("recharts-curve recharts-area-area"),
                h.Attribute("d", areaPath(points)),
              ]),
              h.path([
                ...attributes({ "stroke-width": strokeWidth, fill: "none", "fill-opacity": fillOpacity, height: offset.height, stroke: model.config[series]!.color, width: offset.width }, h),
                h.Class("recharts-curve recharts-area-curve"),
                h.Attribute("d", linePath(points)),
              ]),
            ]),
          ]),
        ]),
      ])
    })
  }

  if ((type === "line" || type === "area") && index !== null) {
    const x = xs[index]!
    contents[1100] = [h.path([
      ...attributes({ stroke: "hsl(var(--muted-foreground) / 0.5)", "pointer-events": "none", ...dims, "stroke-width": 1 }, h),
      h.Class("recharts-curve recharts-tooltip-cursor"),
      h.Attribute("d", `M${d3Round(x)},${d3Round(offset.top)}L${d3Round(x)},${d3Round(bottom)}`),
    ])]
    contents[1200] = visible.flatMap((series) => {
      const top = stacks[series]![index]!.top
      if (top === null) return []
      return [h.g([h.Class("recharts-layer recharts-active-dot")], [
        h.circle([
          ...attributes({ cx: x, cy: y(top), r: 4, fill: model.config[series]!.color, "stroke-width": 2, stroke: "hsl(var(--card))" }, h),
          h.Class("recharts-dot"),
        ]),
      ])]
    })
  }

  const tickGroup = (axis: "x" | "y", count: number) => h.g([h.Class(`recharts-layer recharts-cartesian-axis recharts-${axis}Axis ${axis}Axis`)], [
    h.g([h.Class(`recharts-cartesian-axis-ticks recharts-${axis}Axis-ticks`)], [
      h.g([h.Class(`recharts-cartesian-axis-tick-lines recharts-${axis}Axis-tick-lines`)], Array.from({ length: count }, () => h.g([h.Class("recharts-layer recharts-cartesian-axis-tick")], []))),
    ]),
  ])
  contents[500] = [tickGroup("x", model.data.length), tickGroup("y", layout.yTicks.length)]

  const label = (record: Record<string, string | number>, x: number, dy: string, text: string) => h.g([h.Class("recharts-layer recharts-cartesian-axis-tick-label")], [
    h.text([...attributes(record, h), h.Class("recharts-text recharts-cartesian-axis-tick-value")], [
      h.tspan([h.Attribute("x", String(x)), h.Attribute("dy", dy)], [text]),
    ]),
  ])
  const labelY = bottom + TICK_SIZE + TICK_MARGIN
  const labelX = offset.left - TICK_SIZE - TICK_MARGIN
  contents[2000] = [
    h.g([h.Class("recharts-cartesian-axis-tick-labels recharts-xAxis-tick-labels")], model.data.map((row, dataIndex) => label(
      { height: X_AXIS_HEIGHT, orientation: "bottom", width: offset.width, stroke: "none", "font-size": 12, x: xs[dataIndex]!, y: labelY, "text-anchor": "middle", fill: TICK_FILL },
      xs[dataIndex]!,
      "0.71em",
      String(row[model.xKey] ?? ""),
    ))),
    h.g([h.Class("recharts-cartesian-axis-tick-labels recharts-yAxis-tick-labels")], layout.yTicks.map((tick) => label(
      { width: model.yAxisWidth, orientation: "left", height: offset.height, stroke: "none", "font-size": 12, x: labelX, y: y(tick), "text-anchor": "end", fill: TICK_FILL },
      labelX,
      "0.355em",
      formatCompact(tick, model.hideDecimalValues),
    ))),
  ]

  const tooltip: Tooltip | null = index === null || !pointer
    ? null
    : {
      label: String(model.data[index]![model.xKey] ?? ""),
      entries: visible.flatMap((series) => {
        const value = model.data[index]![series]
        if (value === undefined || value === null) return []
        return [{ name: model.config[series]!.label ?? series, value, color: model.config[series]!.color }]
      }),
      coordinate: { x: xs[index]!, y: pointer.y },
    }

  return {
    svgAttributes: [] as Attribute<Message>[],
    layers: layers(contents, clipDefs(key, offset, h), h),
    tooltip: tooltipWrapper(tooltip, chart, offset, h),
  }
}

function pieChart(key: string, model: ChartModel, chart: ChartState, width: number, height: number, h: HtmlBuilder<Message>) {
  const layout = polarLayout(model, width, height)
  const pointer = chart.hover
  const active = pointer ? activeSector(layout, pointer.x, pointer.y) : null
  const pieId = idFor(key, "recharts-pie")
  const contents: Partial<Record<number, Html[]>> = {
    100: layout.sectors.length === 0 ? [] : [h.g([h.Class("recharts-layer recharts-pie"), h.Attribute("tabindex", "0")], [
      h.g([h.Class("recharts-layer")], layout.sectors.map((sector, index) => h.g([h.Class("recharts-layer recharts-pie-sector"), h.Attribute("tabindex", "-1")], [
        h.g([h.Class(`recharts-layer ${index === active ? "recharts-active-shape" : "recharts-shape"}`)], [
          h.path([
            ...attributes({
              stroke: "none",
              cx: layout.cx,
              cy: layout.cy,
              fill: sector.color,
              name: sector.name,
              opacity: chart.hidden.includes(String(model.data[index]![model.xKey] ?? `Segment ${index + 1}`)) ? 0.18 : 1,
              tabindex: -1,
              "data-recharts-item-index": index,
              "data-recharts-item-id": pieId,
            }, h),
            h.Class("recharts-sector"),
            h.Attribute("d", sectorPath(layout.cx, layout.cy, layout.innerRadius, layout.outerRadius, sector.startAngle, sector.endAngle)),
          ]),
        ]),
      ]))),
    ])],
  }
  const sector = active === null ? null : layout.sectors[active]!
  const tooltip: Tooltip | null = sector
    ? { entries: [{ name: sector.name, value: sector.value, color: sector.color }], coordinate: sector.tooltip }
    : null
  return {
    svgAttributes: [h.Attribute("cx", "50%"), h.Attribute("cy", "50%")],
    layers: layers(contents, clipDefs(key, layout.offset, h), h),
    tooltip: tooltipWrapper(tooltip, chart, layout.offset, h),
  }
}

/** The ResponsiveContainer and what recharts draws in it, once measured. */
function renderChart(key: string, model: ChartModel, chart: ChartState, h: HtmlBuilder<Message>): Html {
  const size = chart.size
  const drawn = size && size.width > 0 && size.height > 0
    ? (model.payload.type === "pie" ? pieChart : cartesianChart)(key, model, chart, size.width, size.height, h)
    : null
  return h.div([
    h.Class("recharts-responsive-container"),
    h.Style({ width: "100%", height: "100%", "min-width": "0px" }),
    h.OnMount(ChartArea({ key })),
  ], [
    h.div([h.Style({ width: "0px", height: "0px", overflow: "visible" })], drawn && size ? [
      h.div([
        h.Attribute("width", String(size.width)),
        h.Attribute("height", String(size.height)),
        h.Class("recharts-wrapper"),
        h.Style({ position: "relative", cursor: "default", width: `${size.width}px`, height: `${size.height}px` }),
      ], [
        drawn.tooltip,
        h.svg([
          ...drawn.svgAttributes,
          h.Role("application"),
          h.Attribute("tabindex", "0"),
          h.Class("recharts-surface"),
          h.Attribute("width", String(size.width)),
          h.Attribute("height", String(size.height)),
          h.Attribute("viewBox", `0 0 ${size.width} ${size.height}`),
          h.Style({ width: "100%", height: "100%", display: "block" }),
        ], [h.title([], []), h.desc([], []), ...drawn.layers]),
      ]),
    ] : []),
  ])
}

/**
 * The chart and its legend (useChartModel's `chartFigure`), for the inline
 * card and the viewer's full size. `key` names its state in the Model.
 */
export function chartFigure(key: string, payload: ChartToolPayload, className: string, context: RowContext, h: HtmlBuilder<Message>): Html {
  const model = chartModel(payload)
  const chart = chartOf(context.model, key)
  return h.div([h.Class(className)], [
    h.div([h.Class("chart-render-area")], [
      model.data.length ? renderChart(key, model, chart, h) : h.div([h.Class("chart-empty")], ["Generating chart..."]),
    ]),
    model.keys.length > 0
      ? h.div([h.Class("chart-legend")], model.legendItems.map(({ key: series, label, color }) => {
        const hidden = chart.hidden.includes(series)
        return h.button([
          h.Type("button"),
          h.AriaPressed(!hidden),
          h.Class(hidden ? "muted" : ""),
          h.OnClick(Message.ToggledChartSeries({ key, series })),
          h.OnMouseEnter(Message.HoveredChartSeries({ key, series })),
          h.OnMouseLeave(Message.HoveredChartSeries({ key, series: null })),
        ], [h.i([h.Style({ ...(color ? { "background-color": color } : {}), opacity: hidden ? "0.45" : "1" })], []), label])
      }))
      : null,
  ])
}

const HEADER_BUTTON_CLASS = "text-muted-foreground hover:text-muted-foreground"

export function chartTool(key: string, payload: ChartToolPayload, context: RowContext, h: HtmlBuilder<Message>): Html {
  const model = chartModel(payload)
  return h.div([h.Class("chart-card")], [
    h.div([h.Class("chart-card-header")], [
      h.div([], [
        h.h3([], [payload.title]),
        payload.description ? h.p([], [payload.description]) : null,
      ]),
      h.div([h.Class("flex items-center gap-1")], [
        h.button([
          h.Class(buttonClass({ variant: "ghost", size: "icon-sm", class: HEADER_BUTTON_CLASS })),
          h.Type("button"),
          h.Title("Download CSV"),
          h.OnClick(Message.ClickedDownloadChartCsv({ csv: model.csv, filename: model.csvFilename })),
        ], [Download({ size: 14 }, h)]),
        h.button([
          h.Class(buttonClass({ variant: "ghost", size: "icon-sm", class: HEADER_BUTTON_CLASS })),
          h.Type("button"),
          h.Title("Expand chart"),
          // Full size opens in the viewer, the same surface as a diff or an
          // attachment, rather than a modal of the chart's own.
          h.OnClick(Message.ClickedExpandChart({ payload })),
        ], [Maximize2({ size: 14 }, h)]),
      ]),
    ]),
    chartFigure(key, payload, "chart-body", context, h),
  ])
}
