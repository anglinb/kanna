import { z } from "zod"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import type { DisplayAttachment } from "../shared/display-tools"
import { storeLocalAttachment } from "./kanna-display-tools"
import { OPENROUTER_BASE_URL, readLlmProviderSnapshot } from "./llm-provider"
import { Effect } from "effect"
import { runKanna } from "./effect/bridge"
import { ServerPlatform } from "./effect/runtime"
import type { KannaToolDefinition } from "./kanna-tools"

/** Nano Banana 2 Lite on OpenRouter. It serves 1K images and takes up to 14 reference images. */
export const IMAGE_MODEL = "google/gemini-3.1-flash-lite-image"

const MAX_IMAGES = 12
const MAX_REFERENCE_IMAGES = 14
// A reference travels inline as a data URL, so one large file would fail the whole request.
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
const ASPECT_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"] as const

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

const imageSchema = z.strictObject({
  prompt: z.string().min(1).describe("What to draw. Describe the subject, composition, palette, and style. The image model cannot see the conversation."),
  path: z.string().min(1).describe("Where to save the image, absolute or relative to the project directory. Parent directories are created. The extension is corrected to match the returned bytes."),
  aspectRatio: z.enum(ASPECT_RATIOS).optional(),
  referenceImages: z.array(z.string().min(1)).max(MAX_REFERENCE_IMAGES).optional()
    .describe("Images to work from. Each entry is a local path, the filename of a file the user attached to this chat, or an HTTP/HTTPS URL. A path may name an image that an earlier call saved."),
})

const generateSchema = z.strictObject({
  images: z.array(imageSchema).min(1).max(MAX_IMAGES)
    .describe("One entry per image. All entries generate in parallel, so put a whole batch in one call. An entry cannot reference an image from the same call."),
})

type ImageRequest = z.infer<typeof imageSchema>
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ImageCredentials {
  apiKey: string
  baseUrl: string
}

/** The key from Settings › Providers › Model Registry, the same one voice input uses. */
export async function readImageCredentials(): Promise<ImageCredentials> {
  const registry = await runKanna(readLlmProviderSnapshot().pipe(Effect.provide(ServerPlatform)))
  if (registry.provider === "openrouter" && registry.apiKey.trim()) {
    return { apiKey: registry.apiKey.trim(), baseUrl: registry.resolvedBaseUrl }
  }
  const envKey = process.env.OPENROUTER_API_KEY?.trim()
  if (envKey) return { apiKey: envKey, baseUrl: OPENROUTER_BASE_URL }
  throw new Error("Image generation needs an OpenRouter API key. Set one under Settings › Providers › Model Registry.")
}

/**
 * A reference entry as a URL the provider can read.
 *
 * Kanna runs on the user's machine, so a local file has no public URL. It
 * travels inline as a data URL. A bare filename that is not in the project is
 * looked up in `.kanna/uploads`, where chat attachments land.
 */
export async function resolveReferenceImage(entry: string, cwd: string): Promise<string> {
  if (/^https?:\/\//i.test(entry)) return entry
  const candidates = [path.resolve(cwd, entry), path.resolve(cwd, ".kanna/uploads", entry)]
  for (const candidate of candidates) {
    const bytes = await readFile(candidate).catch(() => null)
    if (!bytes) continue
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new Error(`Reference image "${entry}" is over 10 MB. Downscale it first.`)
    const mimeType = (await fileTypeFromBuffer(bytes).catch(() => undefined))?.mime
    if (!mimeType || !(mimeType in EXTENSION_BY_MIME)) throw new Error(`Reference "${entry}" is not a png, jpg, gif, or webp image.`)
    return `data:${mimeType};base64,${bytes.toString("base64")}`
  }
  // A missing reference fails the image. Dropping it would return a plausible
  // picture that ignores the one thing the user pointed at.
  throw new Error(`No reference image "${entry}". Expected a local path, an attached filename, or an HTTP/HTTPS URL.`)
}

/** OpenRouter's `/images` endpoint: one JSON request, one JSON response that carries base64. */
export async function requestImage(
  request: { prompt: string; aspectRatio?: string; references: string[] },
  credentials: ImageCredentials,
  signal?: AbortSignal,
  fetchImpl: Fetch = fetch,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await fetchImpl(`${credentials.baseUrl.replace(/\/+$/, "")}/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: request.prompt,
      aspect_ratio: request.aspectRatio,
      input_references: request.references.length
        ? request.references.map((url) => ({ type: "image_url", image_url: { url } }))
        : undefined,
    }),
    signal,
  })
  const text = await response.text()
  let payload: { data?: Array<{ b64_json?: string }>; error?: { message?: string } } = {}
  try { payload = JSON.parse(text) } catch { /* A non-JSON body is reported below. */ }
  if (!response.ok) throw new Error(`Image generation failed (${response.status}): ${payload.error?.message ?? text.slice(0, 300)}`)
  // A 200 can still be a refusal. It carries `error` and no data.
  if (payload.error) throw new Error(`Image generation failed: ${payload.error.message ?? "unknown error"}`)
  const base64 = payload.data?.[0]?.b64_json
  if (!base64) throw new Error("Image generation returned no image.")
  const bytes = Buffer.from(base64, "base64")
  const mimeType = (await fileTypeFromBuffer(bytes).catch(() => undefined))?.mime
  if (!mimeType || !(mimeType in EXTENSION_BY_MIME)) throw new Error("Image generation returned bytes that are not an image.")
  return { bytes, mimeType }
}

/** The model names the file before it knows the format. Build tools read the extension, so it follows the bytes. */
export function pathForMimeType(filePath: string, mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType]
  if (!extension) return filePath
  const current = path.extname(filePath).slice(1).toLowerCase()
  if (current === extension || (extension === "jpg" && current === "jpeg")) return filePath
  return current ? `${filePath.slice(0, -current.length - 1)}.${extension}` : `${filePath}.${extension}`
}

export async function generateImageFile(
  image: ImageRequest,
  context: { cwd: string; signal?: AbortSignal },
  credentials: ImageCredentials,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const references = await Promise.all((image.referenceImages ?? []).map((entry) => resolveReferenceImage(entry, context.cwd)))
  const { bytes, mimeType } = await requestImage({ prompt: image.prompt, aspectRatio: image.aspectRatio, references }, credentials, context.signal, fetchImpl)
  const destination = pathForMimeType(path.resolve(context.cwd, image.path), mimeType)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
  return destination
}

export function createGenerateImagesTool(deps: { readCredentials?: () => Promise<ImageCredentials>; fetchImpl?: Fetch } = {}): KannaToolDefinition {
  return {
    name: "generate_images",
    description: "Generate images with Nano Banana 2 Lite, save each one to the path you give, and show them in the chat. All entries generate in parallel, so request a whole batch in one call. The images are not returned to you inline. Read a saved path if you need to look at one. Reference images carry a character or a style from one image to the next.",
    schema: generateSchema,
    async execute(input, context) {
      const { images } = generateSchema.parse(input)
      const credentials = await (deps.readCredentials ?? readImageCredentials)()
      const results = await Promise.allSettled(images.map((image) => generateImageFile(image, context, credentials, deps.fetchImpl)))
      context.signal.throwIfAborted()

      const attachments: DisplayAttachment[] = []
      const copied: string[] = []
      const lines: string[] = []
      try {
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            lines.push(`Failed ${images[index]!.path}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
            continue
          }
          const stored = await storeLocalAttachment(result.value, context)
          copied.push(stored.destination)
          attachments.push(stored.attachment)
          lines.push(`Saved ${path.relative(context.cwd, result.value) || result.value}`)
        }
      } catch (error) {
        await Promise.all(copied.map((file) => rm(file, { force: true })))
        throw error
      }
      // With nothing to show there is no card, so the call reports as an error.
      if (!attachments.length) throw new Error(lines.join("\n"))
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { displayed: true, attachments },
        // The same shape `send_attachments` stores, so both render through one attachment card.
        transcriptContent: attachments,
      }
    },
  }
}

export const GENERATE_IMAGES_TOOL = createGenerateImagesTool()
