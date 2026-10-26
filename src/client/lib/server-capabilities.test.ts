import { expect, test } from "bun:test"
import { fetchServerCapabilities } from "./server-capabilities"

// What the connection store does with the answer is tested with it
// (src/foldkit/core/stores/connection.test.ts).

test("older servers remain compatible while network failures fail closed", async () => {
  expect((await fetchServerCapabilities((async () => new Response(null, { status: 404 })) as typeof fetch)).cloud).toBe(true)
  expect((await fetchServerCapabilities((async () => { throw new Error("offline") }) as typeof fetch)).cloud).toBe(false)
})
