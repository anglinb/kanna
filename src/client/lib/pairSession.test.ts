import { describe, expect, test } from "bun:test"
import { CLOUD_PAIR_SESSION_PATH } from "../../shared/cloud-api"
import { displayClaimUrl, fetchPairSession, startPairSession } from "./pairSession"

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Records what the lib asked for, so method/path aren't assumed. */
function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" })
    return respond()
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

describe("pair session client", () => {
  test("GET reports status; POST starts a session", async () => {
    const waiting = {
      status: "waiting",
      claimUrl: "https://kanna.sh/machine?pair=ABC123",
      expiresAt: 1,
    }

    const read = recordingFetch(() => jsonResponse({ status: "idle" }))
    expect(await fetchPairSession(read.fetchImpl)).toEqual({ status: "idle" })
    expect(read.calls).toEqual([{ url: CLOUD_PAIR_SESSION_PATH, method: "GET" }])

    const start = recordingFetch(() => jsonResponse(waiting))
    expect(await startPairSession(start.fetchImpl)).toEqual(waiting)
    expect(start.calls).toEqual([{ url: CLOUD_PAIR_SESSION_PATH, method: "POST" }])
  })

  test("a paired machine reports its hosted URL", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({ status: "paired", appOrigin: "https://jakemor-mbp.kanna.sh" })
    )
    expect(await fetchPairSession(fetchImpl)).toEqual({
      status: "paired",
      appOrigin: "https://jakemor-mbp.kanna.sh",
    })
  })

  // Anything the machine can't answer must land on "unsupported" — that's the
  // state the UI falls back to the manual instructions on, so a cloud-mode
  // origin (where the proxy 404s this path) or an older server degrades
  // instead of hanging on "Getting your link…".
  test("404, malformed payloads, and network failures all degrade to unsupported", async () => {
    const notFound = recordingFetch(() => jsonResponse({ error: "Not found" }, 404))
    expect(await fetchPairSession(notFound.fetchImpl)).toEqual({ status: "unsupported" })

    const noStatus = recordingFetch(() => jsonResponse({ claimUrl: "https://kanna.sh/machine" }))
    expect(await fetchPairSession(noStatus.fetchImpl)).toEqual({ status: "unsupported" })

    const html = recordingFetch(() => new Response("<!doctype html>"))
    expect(await fetchPairSession(html.fetchImpl)).toEqual({ status: "unsupported" })

    const offline = recordingFetch(() => {
      throw new Error("offline")
    })
    expect(await startPairSession(offline.fetchImpl)).toEqual({ status: "unsupported" })
  })

  test("displayClaimUrl strips the scheme and any trailing slash", () => {
    expect(displayClaimUrl("https://kanna.sh/machine?pair=ABC123")).toBe("kanna.sh/machine?pair=ABC123")
    expect(displayClaimUrl("https://jakemor-mbp.kanna.sh")).toBe("jakemor-mbp.kanna.sh")
    expect(displayClaimUrl("http://localhost:3210/")).toBe("localhost:3210")
  })
})
