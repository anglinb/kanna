import { expect, test } from "bun:test"
import { fetchServerCapabilities } from "./server-capabilities"
import { useConnectionStore } from "../stores/connectionStore"
import { useServerCapabilitiesStore } from "../stores/serverCapabilitiesStore"

test("a disabled manifest stops all fleet discovery probes", async () => {
  const urls: string[] = []
  const fetchImpl = (async (url: string) => {
    urls.push(url)
    if (url !== "/api/capabilities") throw new Error("disabled client attempted cloud discovery")
    return Response.json({ capabilities: { cloud: false, publicSharing: false } })
  }) as typeof fetch
  await useConnectionStore.getState().load(fetchImpl)
  expect(urls).toEqual(["/api/capabilities"])
  expect(useConnectionStore.getState().mode).toBe("local")
  expect(useConnectionStore.getState().machines).toEqual([])
})

test("desktop fleet injection cannot override a disabled capability", () => {
  useServerCapabilitiesStore.setState({ value: { cloud: false, publicSharing: false } })
  try {
    useConnectionStore.getState().setMacAppFleet({ machines: [{ subdomain: "remote", name: "Remote", appOrigin: "https://remote.kanna.sh", online: true }] })
    expect(useConnectionStore.getState().mode).toBe("local")
    expect(useConnectionStore.getState().machines).toEqual([])
    expect(useConnectionStore.getState().fromMacApp).toBe(false)
  } finally { useServerCapabilitiesStore.setState({ value: null }) }
})

test("older servers remain compatible while network failures fail closed", async () => {
  expect((await fetchServerCapabilities((async () => new Response(null, { status: 404 })) as typeof fetch)).cloud).toBe(true)
  expect((await fetchServerCapabilities((async () => { throw new Error("offline") }) as typeof fetch)).cloud).toBe(false)
})
