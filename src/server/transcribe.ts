import type { LlmProviderSnapshot } from "../shared/types"

// Speech to text for the composer's voice input. The clients POST the raw
// recording to /api/transcribe and get back { text }. The key comes from
// the Model Registry, which must point at OpenRouter: this is OpenRouter's
// /audio/transcriptions call (base64 in JSON, not multipart).
//
// The model is the same one Tressa settled on. microsoft/mai-transcribe-1.5
// rejects the m4a and webm that AVAudioRecorder and MediaRecorder produce.
export const TRANSCRIPTION_MODEL = "openai/gpt-transcribe"

// Base64 plus JSON.stringify keeps about three copies of the audio in
// memory; a minute of 16 kHz AAC is well under 1 MB, so this is generous.
export const MAX_TRANSCRIBE_BYTES = 25_000_000

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "method_not_allowed"
      | "missing_openrouter_key"
      | "empty_audio"
      | "request_too_large"
      | "transcription_failed",
    readonly status: number,
  ) {
    super(message)
    this.name = "TranscriptionError"
  }
}

/** The `format` OpenRouter expects for a recorded Content-Type. */
export function audioFormat(contentType: string): string {
  const subtype = contentType.split(";")[0].trim().toLowerCase().replace(/^audio\//, "")
  switch (subtype) {
    case "mp4":
    case "m4a":
    case "x-m4a":
      return "m4a"
    case "mpeg":
    case "mp3":
      return "mp3"
    case "wav":
    case "x-wav":
      return "wav"
    case "flac":
    case "ogg":
    case "webm":
    case "aac":
      return subtype
    default:
      return "m4a"
  }
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export async function transcribeAudioBytes(
  audio: ArrayBuffer | Uint8Array,
  contentType: string,
  registry: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "resolvedBaseUrl">,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  if (registry.provider !== "openrouter" || !registry.apiKey.trim()) {
    throw new TranscriptionError(
      "Voice input needs an OpenRouter API key. Set one under Settings › Providers › Model Registry.",
      "missing_openrouter_key",
      400,
    )
  }
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio)
  if (bytes.byteLength === 0) {
    throw new TranscriptionError("The recording was empty.", "empty_audio", 400)
  }
  if (bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new TranscriptionError("The recording is too large to transcribe.", "request_too_large", 413)
  }

  const baseUrl = registry.resolvedBaseUrl.replace(/\/+$/, "")
  const response = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${registry.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Kanna",
    },
    body: JSON.stringify({
      model: TRANSCRIPTION_MODEL,
      input_audio: {
        data: Buffer.from(bytes).toString("base64"),
        format: audioFormat(contentType),
      },
    }),
  })

  const body = await response.text()
  if (!response.ok) {
    throw new TranscriptionError(
      `Transcription failed (${response.status}): ${upstreamMessage(body) || response.statusText}`,
      "transcription_failed",
      // A bad key stays a 401 instead of turning into a 500.
      response.status >= 400 && response.status <= 599 ? response.status : 502,
    )
  }

  let payload: { text?: unknown; error?: { message?: string } }
  try {
    payload = JSON.parse(body)
  } catch {
    throw new TranscriptionError("Transcription returned invalid JSON.", "transcription_failed", 502)
  }
  // A 200 with an `error` and no text is how the provider declines.
  if (payload.error) {
    throw new TranscriptionError(`Transcription failed: ${payload.error.message || "unknown error"}`, "transcription_failed", 502)
  }
  return typeof payload.text === "string" ? payload.text : ""
}

function upstreamMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string }
    if (typeof parsed.error === "string") return parsed.error
    return parsed.error?.message ?? ""
  } catch {
    return body.slice(0, 200)
  }
}

/** POST /api/transcribe. Returns null for any other path so the router falls through. */
export async function handleTranscribe(
  req: Request,
  url: URL,
  readRegistry: () => Promise<LlmProviderSnapshot>,
  fetchImpl: Fetch = fetch,
): Promise<Response | null> {
  if (url.pathname !== "/api/transcribe") {
    return null
  }
  if (req.method !== "POST") {
    return errorEnvelope("method_not_allowed", "Use POST for transcription.", 405)
  }
  // The declared length first, so an oversized upload is refused before
  // it is buffered. The real check is on the bytes; the header can be absent.
  const contentLength = Number(req.headers.get("content-length") ?? 0)
  if (contentLength > MAX_TRANSCRIBE_BYTES) {
    return errorEnvelope("request_too_large", "The recording is too large to transcribe.", 413)
  }
  try {
    const text = await transcribeAudioBytes(
      await req.arrayBuffer(),
      req.headers.get("content-type") ?? "audio/mp4",
      await readRegistry(),
      fetchImpl,
    )
    return Response.json({ text }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof TranscriptionError) {
      return errorEnvelope(error.code, error.message, error.status)
    }
    throw error
  }
}

function errorEnvelope(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status })
}
