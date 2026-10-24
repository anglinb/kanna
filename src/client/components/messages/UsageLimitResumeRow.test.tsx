import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { UsageLimitResumeRow } from "./UsageLimitResumeRow"

describe("UsageLimitResumeRow", () => {
  test("says whose usage it waits for and when, with Continue now and a way to turn it off", () => {
    const html = renderToStaticMarkup(
      <UsageLimitResumeRow resume={{ at: Date.now() + 2 * 60 * 60_000 + 5 * 60_000, provider: "codex" }} onAction={() => undefined} />
    )
    expect(html).toContain("Continues when Codex usage resets")
    expect(html).toContain("in 2h 5m")
    expect(html).toContain('aria-label="Continue now"')
    expect(html).toContain('aria-label="Don&#x27;t continue automatically"')
    // The dashed outline of something still waiting, as a queued message has.
    expect(html).toContain("border-dashed")
  })
})
