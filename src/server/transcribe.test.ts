import { describe, expect, test } from "bun:test"
import { audioFormat, handleTranscribe, TRANSCRIPTION_MODEL } from "./transcribe"
import type { LlmProviderSnapshot } from "../shared/types"

function registry(overrides: Partial<LlmProviderSnapshot> = {}): LlmProviderSnapshot {
  return {
    provider: "openrouter",
    apiKey: "sk-or-test",
    model: "x",
    baseUrl: "",
    resolvedBaseUrl: "https://openrouter.ai/api/v1",
    faveModels: [],
    enabled: true,
    warning: null,
    filePathDisplay: "~/.kanna/llm-provider.json",
    ...overrides,
  }
}

function request(body: BodyInit | null, init: RequestInit = {}) {
  return new Request("http://localhost/api/transcribe", { method: "POST", body, ...init })
}

const url = new URL("http://localhost/api/transcribe")

describe("audioFormat", () => {
  test("maps recorder mime types to OpenRouter formats", () => {
    expect(audioFormat("audio/mp4")).toBe("m4a")
    expect(audioFormat("audio/m4a")).toBe("m4a")
    expect(audioFormat("audio/webm;codecs=opus")).toBe("webm")
    expect(audioFormat("audio/mpeg")).toBe("mp3")
    expect(audioFormat("text/plain")).toBe("m4a")
  })
})

describe("handleTranscribe", () => {
  test("ignores other paths", async () => {
    const other = new URL("http://localhost/api/other")
    expect(await handleTranscribe(request("x"), other, async () => registry())).toBeNull()
  })

  test("rejects non-POST", async () => {
    const response = await handleTranscribe(new Request(url, { method: "GET" }), url, async () => registry())
    expect(response?.status).toBe(405)
  })

  test("needs an OpenRouter key", async () => {
    const response = await handleTranscribe(request("abc"), url, async () => registry({ provider: "openai" }))
    expect(response?.status).toBe(400)
    const body = await response!.json()
    expect(body.error.code).toBe("missing_openrouter_key")
  })

  test("rejects an empty body", async () => {
    const response = await handleTranscribe(request(""), url, async () => registry())
    expect(response?.status).toBe(400)
    expect((await response!.json()).error.code).toBe("empty_audio")
  })

  test("posts base64 audio to OpenRouter and returns the text", async () => {
    let seen: { url: string; body: any; auth: string | null } | null = null
    const fetchImpl = async (input: string | URL, init?: RequestInit) => {
      seen = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      }
      return Response.json({ text: "hello there" })
    }
    const response = await handleTranscribe(
      request(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/webm;codecs=opus" } }),
      url,
      async () => registry(),
      fetchImpl,
    )
    expect(response?.status).toBe(200)
    expect(await response!.json()).toEqual({ text: "hello there" })
    expect(seen!.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
    expect(seen!.auth).toBe("Bearer sk-or-test")
    expect(seen!.body.model).toBe(TRANSCRIPTION_MODEL)
    expect(seen!.body.input_audio).toEqual({ data: Buffer.from([1, 2, 3]).toString("base64"), format: "webm" })
  })

  test("passes upstream failures through", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })
    const response = await handleTranscribe(request("abc"), url, async () => registry(), fetchImpl)
    expect(response?.status).toBe(401)
    const body = await response!.json()
    expect(body.error.code).toBe("transcription_failed")
    expect(body.error.message).toContain("bad key")
  })
})
