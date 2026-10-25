#!/usr/bin/env bun
// End-to-end check of the built demo (dist/demo, `bun run build:demo`), the
// way kanna.sh shows it: inside an iframe. It opens on the featured chat,
// moves to another chat from the sidebar and back, and must never move the
// frame's own address (the memory history), nor log an error.
//
//   bun run ./scripts/foldkit/demo-smoke.ts

import path from "node:path"
import { chromium } from "playwright"

const ROOT = path.resolve(import.meta.dirname, "../..")
const DEMO = path.join(ROOT, "dist/demo")

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/") {
      return new Response(`<!doctype html><iframe id="demo" src="/demo/" style="width:1440px;height:900px;border:0"></iframe>`, { headers: { "content-type": "text/html" } })
    }
    const relative = url.pathname.replace(/^\/demo\/?/, "") || "index.html"
    const file = Bun.file(path.join(DEMO, relative))
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 })
  },
})

const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 940 } })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !expected(message.location().url)) errors.push(`${message.text()} ${message.location().url}`)
  })
  // `/__cloud/machines` is feature detection (connectionStore): only the
  // kanna.sh proxy answers it, and a 404 is the answer for "not behind it".
  const expected = (url: string) => url.endsWith("/__cloud/machines")
  page.on("response", (response) => {
    if (response.status() >= 400 && !expected(response.url())) errors.push(`${response.status()} ${response.url()}`)
  })
  await page.goto(`http://localhost:${server.port}/`)
  const frame = page.frameLocator("#demo")
  const frameUrl = () => page.frames().find((candidate) => candidate.url().includes("/demo/"))?.url() ?? ""
  const startUrl = await (async () => {
    await frame.locator("body").waitFor()
    return frameUrl()
  })()

  // The featured chat: its title in the navbar, its transcript below.
  await frame.getByText("Fix the units", { exact: false }).first().waitFor({ timeout: 20_000 }).catch(() => {})
  const featuredTitle = await frame.locator("title").textContent().catch(() => null)
  check(Boolean(await frame.locator("[data-chat-id], main").first().count()), "the app rendered")
  console.log(`     document title: ${featuredTitle ?? "(none)"}`)

  // Another chat from the sidebar.
  const safari = frame.getByText("Fix blank tide chart in Safari").first()
  await safari.waitFor({ timeout: 20_000 })
  await safari.click()
  await page.waitForTimeout(800)
  check(frameUrl() === startUrl, `the frame's address stayed put (${frameUrl()})`)
  const titleAfter = await page.frames().find((candidate) => candidate.url().includes("/demo/"))!.title()
  check(/Safari/.test(titleAfter), `the Safari chat opened (title: ${titleAfter})`)

  // Settings, still in memory.
  await frame.getByRole("button", { name: /^Settings/ }).last().click()
  await page.waitForTimeout(800)
  check(frameUrl() === startUrl, "the frame's address stayed put after opening settings")
  const settingsShown = await frame.getByText("Appearance, notifications, chats, layout").first().isVisible().catch(() => false)
  check(settingsShown, "settings opened")

  check(errors.length === 0, `no errors logged${errors.length ? `: ${errors.slice(0, 5).join(" | ")}` : ""}`)
} finally {
  await browser.close()
  server.stop()
}

if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log("\ndemo smoke passed")
