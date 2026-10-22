import { describe, expect, test } from "bun:test"
import {
  cssColorAlpha,
  isPngSignature,
  VISUALIZATION_CAPTURE_GEOMETRY,
  VISUALIZATION_CAPTURE_SCRIPT,
  VISUALIZATION_IMAGE_TYPES,
  visualizationImageFilename,
  visualizationImageName,
} from "./visualization-capture"
import { prepareVisualizationDocument } from "./visualization-host"

// The very source the script ships with, run on its own.
const { captureSize } = new Function(`${VISUALIZATION_CAPTURE_GEOMETRY}; return { captureSize }`)() as {
  captureSize: (width: number, height: number, pixelRatio: number) => { scale: number, width: number, height: number }
}

describe("captureSize", () => {
  test("draws at the screen's density, never under 2x and never over 3x", () => {
    expect(captureSize(800, 600, 1)).toEqual({ scale: 2, width: 1600, height: 1200 })
    expect(captureSize(800, 600, 2)).toEqual({ scale: 2, width: 1600, height: 1200 })
    expect(captureSize(800, 600, 2.5)).toEqual({ scale: 2.5, width: 2000, height: 1500 })
    expect(captureSize(800, 600, 4)).toEqual({ scale: 3, width: 2400, height: 1800 })
    expect(captureSize(800, 600, 0).scale).toBe(2)
  })

  test("scales a tall page down to what a canvas can hold", () => {
    const tall = captureSize(1000, 12000, 2)
    expect(tall.height).toBeLessThanOrEqual(16384)
    expect(tall.width * tall.height).toBeLessThanOrEqual(16_777_216)
    expect(tall.scale).toBeLessThan(2)
  })
})

describe("the capture script", () => {
  test("parses, and stands down for a copy that ran first", () => {
    expect(() => new Function(VISUALIZATION_CAPTURE_SCRIPT)).not.toThrow()
    expect(VISUALIZATION_CAPTURE_SCRIPT.startsWith("(() => {\n  if (window.__kannaCapture) return;")).toBe(true)
  })

  test("can sit in a script element", () => {
    expect(VISUALIZATION_CAPTURE_SCRIPT).not.toContain("</script")
  })

  test("goes into every document at load, and the shell passes the request down and the image up", () => {
    const inner = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><p>Chart</p></body></html>'
    const shell = `<html><head></head><body><iframe id="visualization" sandbox="allow-scripts" srcdoc="${inner.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe></body></html>`
    const prepared = prepareVisualizationDocument(shell, { appearance: "dark", variables: {} }, "")
    expect(prepared).toContain("window.__kannaCapture")
    expect(prepared).toContain("event.data?.type === 'kanna:capture'")
    expect(prepared).toContain("event.data?.type === 'kanna:captured'")
  })
})

describe("visualizationImageName", () => {
  test("slugs the title", () => {
    expect(visualizationImageName("Weekly Revenue, by Region (2026)")).toBe("weekly-revenue-by-region-2026")
    expect(visualizationImageName("Café — Überblick")).toBe("cafe-uberblick")
  })

  test("falls back to visualization", () => {
    expect(visualizationImageName("")).toBe("visualization")
    expect(visualizationImageName("📈 ✨")).toBe("visualization")
  })

  test("is held to 80 characters without a dangling dash", () => {
    const slug = visualizationImageName(`${"a".repeat(79)} b`)
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug.endsWith("-")).toBe(false)
  })
})

describe("image types", () => {
  test("map to their MIME type and extension", () => {
    expect(VISUALIZATION_IMAGE_TYPES.png).toMatchObject({ mimeType: "image/png", extension: "png" })
    expect(VISUALIZATION_IMAGE_TYPES.jpeg).toMatchObject({ mimeType: "image/jpeg", extension: "jpg" })
    expect(VISUALIZATION_IMAGE_TYPES.webp).toMatchObject({ mimeType: "image/webp", extension: "webp" })
    expect(Object.keys(VISUALIZATION_IMAGE_TYPES)).toEqual(["png", "jpeg", "webp"])
  })
})

describe("visualizationImageFilename", () => {
  test("adds the type's extension, PNG by default", () => {
    expect(visualizationImageFilename("revenue", "Revenue")).toBe("revenue.png")
    expect(visualizationImageFilename("revenue", "Revenue", "jpeg")).toBe("revenue.jpg")
    expect(visualizationImageFilename("revenue", "Revenue", "webp")).toBe("revenue.webp")
  })

  test("swaps an image extension typed for another type, and never doubles one", () => {
    expect(visualizationImageFilename("revenue.png", "Revenue")).toBe("revenue.png")
    expect(visualizationImageFilename("revenue.PNG", "Revenue", "jpeg")).toBe("revenue.jpg")
    expect(visualizationImageFilename("revenue.jpeg", "Revenue", "webp")).toBe("revenue.webp")
    expect(visualizationImageFilename("revenue.webp", "Revenue", "png")).toBe("revenue.png")
    // Not an image extension: part of the name.
    expect(visualizationImageFilename("v1.2", "Revenue")).toBe("v1.2.png")
  })

  test("drops what a file system will not take", () => {
    expect(visualizationImageFilename('a/b\\c:d*e?"f"<g>|h', "T")).toBe("a-b-c-d-e-f-g-h.png")
    expect(visualizationImageFilename("..hidden", "T")).toBe("hidden.png")
    expect(visualizationImageFilename("line\nbreak", "T")).toBe("line-break.png")
  })

  test("falls back to the title for an empty name", () => {
    expect(visualizationImageFilename("   ", "Sales Funnel", "jpeg")).toBe("sales-funnel.jpg")
    expect(visualizationImageFilename(".png", "", "png")).toBe("visualization.png")
  })
})

describe("cssColorAlpha", () => {
  test("reads the alpha of computed colors", () => {
    expect(cssColorAlpha("rgb(255, 255, 255)")).toBe(1)
    expect(cssColorAlpha("rgba(0, 0, 0, 0)")).toBe(0)
    expect(cssColorAlpha("rgba(0, 0, 0, 0.5)")).toBe(0.5)
    expect(cssColorAlpha("transparent")).toBe(0)
    expect(cssColorAlpha("oklch(0.2 0.01 250 / 0.4)")).toBe(0.4)
    expect(cssColorAlpha("color(srgb 1 1 1 / 50%)")).toBe(0.5)
    expect(cssColorAlpha("oklch(0.2 0.01 250)")).toBe(1)
  })
})

describe("isPngSignature", () => {
  test("takes only the PNG signature", () => {
    expect(isPngSignature(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true)
    expect(isPngSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe(false)
    expect(isPngSignature(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false)
  })
})
