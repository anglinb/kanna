// Where the reader is, measured when a read position is written rather than
// when it was sampled (useChatReadAnchor took a function to call at write
// time): the layout has settled by then. The transcript's viewport registers
// how to measure its chat; the session's write asks.

export interface ReadAnchorLayout {
  transcriptWidth: number
  offsetFromMessage: number
}

type Measure = (messageId: string) => ReadAnchorLayout | null

const measures = new Map<string, Measure>()

/** While a chat's transcript is on the page. Returns the unregister. */
export function registerReadAnchorMeasure(chatId: string, measure: Measure): () => void {
  measures.set(chatId, measure)
  return () => {
    if (measures.get(chatId) === measure) measures.delete(chatId)
  }
}

/** The position now, or null when the chat's transcript is gone (then the sample stands). */
export function measureReadAnchor(chatId: string, messageId: string): ReadAnchorLayout | null {
  return measures.get(chatId)?.(messageId) ?? null
}
