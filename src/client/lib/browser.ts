/**
 * Whether this is a Chromium browser (Chrome, Edge, Arc, Brave...).
 *
 * Used to gate `content-visibility: auto` on transcript rows. Chromium has
 * scroll anchoring, which absorbs the size correction when a skipped row
 * renders for the first time. Safari does not, and on it that correction
 * slides the text under the reader's finger, so Safari keeps the full
 * layout. Firefox is left out too until it is measured.
 */
export function isChromium(): boolean {
  if (typeof navigator === "undefined") return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands
  if (brands) return brands.some((entry) => entry.brand === "Chromium")
  // Every Chromium desktop build says "Chrome/" (Edge and Opera included).
  // Chrome on iOS says "CriOS" and is WebKit underneath, so it stays out.
  return /Chrome\/\d/.test(navigator.userAgent)
}
