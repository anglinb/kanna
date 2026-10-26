/** "/__gallery/buttons" → "buttons". Gallery pages compare one component in isolation. */
export function galleryName(pathname: string): string | null {
  const match = /^\/__gallery\/([\w-]+)\/?$/.exec(pathname)
  return match ? match[1]! : null
}
