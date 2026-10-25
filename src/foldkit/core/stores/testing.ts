// Test helpers for the store modules (not a test file itself).

/** A `Storage` in memory, for `load(storage)` and the save Commands' effects. */
export function memoryStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries))
  return {
    get length() {
      return values.size
    },
    key: (index) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}

/** zustand's persist envelope, as the React stores wrote it. */
export function persisted(state: unknown, version: number) {
  return JSON.stringify({ state, version })
}

/**
 * Sends Messages one after another and returns the Model at the end, for
 * tests about state alone; Story tests check the Commands.
 */
export function run<Model, Message>(
  update: (model: Model, message: Message) => { readonly model: Model },
  model: Model,
  ...messages: Message[]
): Model {
  return messages.reduce((current, message) => update(current, message).model, model)
}
