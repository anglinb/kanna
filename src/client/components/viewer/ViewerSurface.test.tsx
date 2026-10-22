import { describe, expect, test } from "bun:test"
import { viewerNavigationStep, type ViewerNavigation } from "./ViewerSurface"

const navigation: ViewerNavigation = { index: 1, count: 3, onPrevious: () => {}, onNext: () => {} }
const key = (value: string, extra: Partial<{ defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
  key: value, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, ...extra,
})

describe("viewerNavigationStep", () => {
  test("j and ] step on, k and [ step back", () => {
    expect(viewerNavigationStep(key("j"), { navigation, typing: false })).toBe("next")
    expect(viewerNavigationStep(key("]"), { navigation, typing: false })).toBe("next")
    expect(viewerNavigationStep(key("k"), { navigation, typing: false })).toBe("previous")
    expect(viewerNavigationStep(key("["), { navigation, typing: false })).toBe("previous")
  })

  test("leaves a key typed in a field to the field", () => {
    expect(viewerNavigationStep(key("j"), { navigation, typing: true })).toBeNull()
    expect(viewerNavigationStep(key("k"), { navigation, typing: true })).toBeNull()
  })

  test("leaves a key with a modifier, or one a menu already took, alone", () => {
    expect(viewerNavigationStep(key("j", { metaKey: true }), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j", { ctrlKey: true }), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j", { altKey: true }), { navigation, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j", { defaultPrevented: true }), { navigation, typing: false })).toBeNull()
  })

  test("does nothing at an end, or with one item, or none", () => {
    expect(viewerNavigationStep(key("j"), { navigation: { ...navigation, hasNext: false }, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("k"), { navigation: { ...navigation, hasPrevious: false }, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j"), { navigation: { ...navigation, count: 1 }, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("j"), { navigation: undefined, typing: false })).toBeNull()
    expect(viewerNavigationStep(key("x"), { navigation, typing: false })).toBeNull()
  })
})

describe("the navigation's buttons", () => {
  test("carry their labels, and are disabled at the ends", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server")
    const { ViewerSurface } = await import("./ViewerSurface")
    const { TooltipProvider } = await import("../ui/tooltip")
    const html = renderToStaticMarkup(
      <TooltipProvider>
      <ViewerSurface
        label="Diff"
        title="Changes"
        onClose={() => {}}
        navigation={{ ...navigation, index: 0, previousLabel: "Previous file · K", nextLabel: "Next file · J", hasPrevious: false, hasNext: true }}
      >
        body
      </ViewerSurface>
      </TooltipProvider>,
    )
    expect(html).toMatch(/aria-label="Previous file · K" aria-disabled="true"/)
    expect(html).toContain('aria-label="Next file · J"')
    expect(html).not.toMatch(/aria-label="Next file · J" aria-disabled/)
  })
})
