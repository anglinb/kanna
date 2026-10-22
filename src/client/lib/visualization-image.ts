import { VISUALIZATION_IMAGE_TYPES, type VisualizationImageType } from "../../shared/visualization-capture"

export function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality))
}

const encodable = new Map<VisualizationImageType, boolean>()

/** Safari's canvas writes no WebP: asked for one, it hands back a PNG. */
export function canEncodeImageType(type: VisualizationImageType): boolean {
  if (type === "png") return true
  let known = encodable.get(type)
  if (known === undefined) {
    const { mimeType } = VISUALIZATION_IMAGE_TYPES[type]
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    known = canvas.toDataURL(mimeType).startsWith(`data:${mimeType}`)
    encodable.set(type, known)
  }
  return known
}

/** A PNG blob as an image to draw, decoded. Revoke the URL when done with it. */
export async function loadImageBlob(blob: Blob): Promise<{ image: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(blob)
  const image = new Image()
  image.src = url
  try {
    await image.decode()
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  return { image, url }
}

/**
 * The capture in the type asked for. The page draws a PNG with its
 * background already painted in, so a JPEG made from it has no transparency
 * to lose.
 */
export async function encodeVisualizationImage(png: Blob, type: VisualizationImageType): Promise<Blob> {
  if (type === "png") return png
  const { mimeType, label } = VISUALIZATION_IMAGE_TYPES[type]
  const { image, url } = await loadImageBlob(png)
  try {
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext("2d")?.drawImage(image, 0, 0)
    const blob = await canvasToBlob(canvas, mimeType, 0.92)
    if (!blob || blob.type !== mimeType) throw new Error(`This browser cannot save a ${label}.`)
    return blob
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = window.document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
