import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Story } from "foldkit/test"
import type { CloudMachineSummary } from "../../../shared/cloud-api"
import {
  findCurrentMachine,
  initialModel,
  LoadConnection,
  loadConnection,
  Message,
  update as updateWith,
  type Context,
  type Model,
} from "./connection"
import { run } from "./testing"

const MACHINES: CloudMachineSummary[] = [
  {
    subdomain: "jakemor-mbp",
    name: "Jake's MBP",
    appOrigin: "https://jakemor-mbp.kanna.sh",
    online: true,
    lastSeenAt: 1,
  },
  {
    subdomain: "jakemor-studio",
    name: "Studio",
    appOrigin: "https://jakemor-studio.kanna.sh",
    online: false,
    lastSeenAt: null,
  },
]

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const CLOUD: Context = { capabilities: { cloud: true, publicSharing: true } }
const update = (model: Model, message: Message) => updateWith(model, message, CLOUD)

/** `load` with this fetch: the requests, then what update makes of their answer. */
async function load(fetchImpl: typeof fetch, model: Model = initialModel): Promise<Model> {
  const message = await Effect.runPromise(loadConnection(fetchImpl))
  return update(model, message).model
}

describe("connection: the Mac app's fleet", () => {
  test("the app's list wins over the page's own detection", async () => {
    const pushed = run(update, initialModel, Message.ReceivedMacAppFleet({
      fleet: { machines: MACHINES, thisMachine: "jakemor-mbp", showing: "jakemor-studio" },
    }))
    const fetchImpl = (async () => jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    const state = await load(fetchImpl, pushed)
    expect(state.mode).toBe("cloud")
    expect(state.machines).toEqual(MACHINES)
    expect(state.thisMachine).toBe("jakemor-mbp")
    expect(state.showingMachine).toBe("jakemor-studio")
  })

  test("the app's list also wins over a proxy's machine list that lands after it", () => {
    const pushed = run(update, initialModel, Message.ReceivedMacAppFleet({ fleet: { machines: MACHINES.slice(0, 1) } }))
    const state = run(update, pushed, Message.ReceivedCloudMachines({ machines: MACHINES }))
    expect(state.machines).toEqual(MACHINES.slice(0, 1))
  })

  test("null after a list (signed out) goes back to detection", () => {
    const state = run(
      update,
      initialModel,
      Message.ReceivedMacAppFleet({ fleet: { machines: MACHINES } }),
      Message.ReceivedMacAppFleet({ fleet: null }),
    )
    expect(state.mode).toBe("unknown")
    expect(state.fromMacApp).toBe(false)
    expect(state.thisMachine).toBeNull()
  })

  test("null before any list leaves detection alone", () => {
    const state = run(update, { ...initialModel, mode: "local" }, Message.ReceivedMacAppFleet({ fleet: null }))
    expect(state.mode).toBe("local")
  })

  test("a server that is not a cloud machine stays local whatever the app pushes", () => {
    const result = updateWith(initialModel, Message.ReceivedMacAppFleet({ fleet: { machines: MACHINES } }), {
      capabilities: { cloud: false, publicSharing: false },
    })
    expect(result.model.mode).toBe("local")
    expect(result.model.fromMacApp).toBe(false)
  })
})

describe("connection: load", () => {
  test("is a Command that ends in one of its Messages", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.FoundServerNotCloud()),
      Story.Command.expectNone(),
      Story.model((model) => expect(model.mode).toBe("local")),
    )
    expect(LoadConnection().name).toBe("LoadConnection")
  })

  test("a disabled manifest stops all fleet discovery probes", async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      if (url !== "/api/capabilities") throw new Error("disabled client attempted cloud discovery")
      return Response.json({ capabilities: { cloud: false, publicSharing: false } })
    }) as unknown as typeof fetch
    const state = await load(fetchImpl)
    expect(urls).toEqual(["/api/capabilities"])
    expect(state.mode).toBe("local")
    expect(state.machines).toEqual([])
  })

  test("JSON 200 from /__cloud/machines → cloud mode with machines", async () => {
    const fetchImpl = (async () => jsonResponse({ machines: MACHINES })) as unknown as typeof fetch
    const state = await load(fetchImpl)
    expect(state.mode).toBe("cloud")
    expect(state.machines).toEqual(MACHINES)
  })

  test("on localhost, a paired machine's own Fleet → cloud mode naming itself", async () => {
    const fetchImpl = (async (url: string) =>
      url === "/api/cloud/fleet"
        ? jsonResponse({ self: "jakemor-mbp", machines: MACHINES })
        : jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    const state = await load(fetchImpl)
    expect(state.mode).toBe("cloud")
    expect(state.machines).toEqual(MACHINES)
    expect(state.thisMachine).toBe("jakemor-mbp")
    expect(state.showingMachine).toBe("jakemor-mbp")
  })

  test("an unpaired machine's empty Fleet → local mode", async () => {
    const fetchImpl = (async (url: string) =>
      url === "/api/cloud/fleet"
        ? jsonResponse({ self: null, machines: [] })
        : jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    expect((await load(fetchImpl)).mode).toBe("local")
  })

  test("machine's explicit 404 → local mode", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    expect((await load(fetchImpl)).mode).toBe("local")
  })

  test("HTML 200 (stale server SPA fallback) → local mode", async () => {
    const fetchImpl = (async () =>
      new Response("<!doctype html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch
    expect((await load(fetchImpl)).mode).toBe("local")
  })

  test("network failure → local mode", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect((await load(fetchImpl)).mode).toBe("local")
  })
})

describe("findCurrentMachine", () => {
  test("matches by hostname", () => {
    expect(findCurrentMachine(MACHINES, "jakemor-mbp.kanna.sh")?.subdomain).toBe("jakemor-mbp")
    expect(findCurrentMachine(MACHINES, "JAKEMOR-STUDIO.kanna.sh:443")?.subdomain).toBe("jakemor-studio")
    expect(findCurrentMachine(MACHINES, "localhost:3210")).toBeNull()
  })
})
